#!/usr/bin/env python3
"""Fixed HELA-12595 reporter; socket activation keeps the key outside uid 1000.

The disk GC remains under the agent UID because it touches agent worktrees.  This
service never executes GC code and never accepts a caller-selected URL or issue.
"""

import json
import os
import socket
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from service_http import request as service_request


SIGNAL_ISSUE = "f6775544-fb1c-4380-906c-66e4f5fb7028"
MAX_REQUEST = 256
REQUEST_DEADLINE_S = 2
MAX_WORKERS = 4
MAX_IN_FLIGHT = 8
CRITICAL_VOLUMES = (
    ("/", "root (`/`)", 10),
    ("/mnt/HC_Volume_106646767", "sdb", 10),
)
REPORT_GAP_S = 2 * 3600
last_reported = {}
report_lock = threading.Lock()


def measured_pressure():
    """Only the service's own filesystem measurements may authorize a wake."""
    critical = []
    for path, label, threshold_gb in CRITICAL_VOLUMES:
        if path != "/" and not os.path.ismount(path):
            continue
        stats = os.statvfs(path)
        free_gb = stats.f_bavail * stats.f_frsize / 1e9
        if free_gb < threshold_gb:
            critical.append((label, free_gb, threshold_gb))
    return critical


def report(message, peer_uid):
    if peer_uid != 1000 or not isinstance(message, dict) or message != {"event": "critical"}:
        raise ValueError("invalid reporter request")
    # Multiple socket workers must not issue the same alarm before the cooldown
    # is recorded. The HTTP request is bounded by the service transport timeout.
    with report_lock:
        critical = measured_pressure()
        if not critical:
            raise ValueError("disk pressure not confirmed")
        now = time.monotonic()
        fresh = [(label, free_gb, threshold_gb) for label, free_gb, threshold_gb in critical
                 if now - last_reported.get(label, float("-inf")) >= REPORT_GAP_S]
        if not fresh:
            return {"local": True}
        measurements = "\n".join(
            f"- {label}: свободно {free_gb:.1f} ГБ, критический порог {threshold_gb} ГБ."
            for label, free_gb, threshold_gb in fresh
        )
        comment = ("🚨 **Disk CRITICAL** — сервисный замер свободного места:\n"
                   f"{measurements}\n\n"
                   "Состояние уборки проверьте в локальном журнале дискового сторожа.")
        result = service_request("PATCH", f"/api/issues/{SIGNAL_ISSUE}",
                                 {"status": "todo", "comment": comment})
        for label, _free_gb, _threshold_gb in fresh:
            last_reported[label] = now
        return result


def read_request(connection):
    deadline = time.monotonic() + REQUEST_DEADLINE_S
    raw = bytearray()
    while b"\n" not in raw and len(raw) <= MAX_REQUEST:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request deadline exceeded")
        connection.settimeout(remaining)
        chunk = connection.recv(MAX_REQUEST + 1 - len(raw))
        if not chunk:
            break
        raw.extend(chunk)
    line, separator, _rest = bytes(raw).partition(b"\n")
    if not separator or len(line) + 1 > MAX_REQUEST:
        raise ValueError("invalid request length")
    return json.loads(line)


def serve_one(connection):
    try:
        raw_peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, peer_uid, _gid = struct.unpack("3i", raw_peer)
        report(read_request(connection), peer_uid)
        response = {"ok": True}
    except Exception as error:
        # Never echo upstream responses, credential paths, request bodies or DSNs.
        response = {"ok": False, "error": type(error).__name__}
    try:
        connection.sendall(json.dumps(response).encode() + b"\n")
    except OSError:
        pass


def serve_connection(connection, slots):
    try:
        with connection:
            serve_one(connection)
    finally:
        slots.release()


def dispatch_connection(connection, workers, slots):
    if not slots.acquire(blocking=False):
        connection.close()
        return False
    try:
        workers.submit(serve_connection, connection, slots)
    except Exception:
        slots.release()
        connection.close()
        raise
    return True


def main():
    if int(os.environ.get("LISTEN_FDS", "0")) != 1:
        raise SystemExit("one systemd socket is required")
    slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
    with socket.socket(fileno=3) as listener, ThreadPoolExecutor(max_workers=MAX_WORKERS) as workers:
        while True:
            connection, _address = listener.accept()
            dispatch_connection(connection, workers, slots)


if __name__ == "__main__":
    main()
