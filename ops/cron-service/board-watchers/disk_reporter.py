#!/usr/bin/env python3
"""Fixed HELA-12595 reporter; socket activation keeps the key outside uid 1000.

The disk GC remains under the agent UID because it touches agent worktrees.  This
service never executes GC code and never accepts a caller-selected URL or issue.
"""

import json
import os
import socket
import struct
import time

from service_http import request as service_request


SIGNAL_ISSUE = "f6775544-fb1c-4380-906c-66e4f5fb7028"
MAX_REQUEST = 256
CRITICAL_VOLUMES = (
    ("/", "root (`/`)", 10),
    ("/mnt/HC_Volume_106646767", "sdb", 10),
)
REPORT_GAP_S = 2 * 3600
last_reported = {}


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


def serve_one(connection):
    try:
        raw_peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, peer_uid, _gid = struct.unpack("3i", raw_peer)
        with connection.makefile("rb") as stream:
            raw = stream.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST or not raw.endswith(b"\n"):
            raise ValueError("invalid request length")
        report(json.loads(raw), peer_uid)
        response = {"ok": True}
    except Exception as error:
        # Never echo upstream responses, credential paths, request bodies or DSNs.
        response = {"ok": False, "error": type(error).__name__}
    try:
        connection.sendall(json.dumps(response).encode() + b"\n")
    except OSError:
        pass


def main():
    if int(os.environ.get("LISTEN_FDS", "0")) != 1:
        raise SystemExit("one systemd socket is required")
    with socket.socket(fileno=3) as listener:
        while True:
            connection, _address = listener.accept()
            with connection:
                connection.settimeout(35)
                serve_one(connection)


if __name__ == "__main__":
    main()
