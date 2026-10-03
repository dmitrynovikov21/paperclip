#!/usr/bin/env python3
"""Fixed HELA-12595 reporter; socket activation keeps the key outside uid 1000.

The disk GC remains under the agent UID because it touches agent worktrees.  This
service never executes GC code and never accepts a caller-selected URL or issue.
"""

import json
import os
import socket
import struct

from service_http import request as service_request


SIGNAL_ISSUE = "f6775544-fb1c-4380-906c-66e4f5fb7028"
MAX_REQUEST = 32_768
MAX_BODY = 12_000


def report(message, peer_uid):
    if peer_uid != 1000 or not isinstance(message, dict) or set(message) != {"action", "body"}:
        raise ValueError("invalid reporter request")
    action, body = message["action"], message["body"]
    if action not in {"note", "escalate"} or not isinstance(body, str) or not 0 < len(body) <= MAX_BODY:
        raise ValueError("invalid reporter action or body")
    if not body.startswith(("🚨 **Эскалация дискового сторожа**", "🟡 **Срабатывание дискового сторожа**", "🚨 **Disk CRITICAL**")):
        raise ValueError("invalid disk signal")
    if action == "escalate":
        return service_request("PATCH", f"/api/issues/{SIGNAL_ISSUE}", {"status": "todo", "comment": body})
    # The board-issued disk_guard scope deliberately has no comment-only route.
    # A routine note stays with the agent-side disk log; accepting it here must
    # not wake the issue or attempt a broader credential fallback.
    return {"local": True}


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
