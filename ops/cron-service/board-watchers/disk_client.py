#!/usr/bin/env python3
"""Send one bounded disk signal through the root-owned reporter socket."""

import json
import os
import socket
import sys


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"note", "escalate"}:
        raise SystemExit("usage: disk_client.py note|escalate")
    body = sys.stdin.read(12_001)
    if not 0 < len(body) <= 12_000:
        raise SystemExit("invalid disk signal length")
    request = json.dumps({"action": sys.argv[1], "body": body}).encode() + b"\n"
    if len(request) > 32_768:
        raise SystemExit("disk signal exceeds socket limit")
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(35)
        connection.connect(os.environ.get("DISK_REPORT_SOCKET", "/run/paperclip-cron/disk-report.sock"))
        connection.sendall(request)
        with connection.makefile("rb") as stream:
            result = stream.readline(257)
    if not json.loads(result).get("ok"):
        raise SystemExit("disk signal rejected")


if __name__ == "__main__":
    main()
