#!/usr/bin/env python3
"""Call the host service broker without receiving or handling its API key."""

import json
import os
import socket
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: api_client.py METHOD /api/path")
    body = None if sys.argv[1] == "GET" else json.load(sys.stdin)
    call = json.dumps({"method": sys.argv[1], "path": sys.argv[2], "body": body}).encode() + b"\n"
    if len(call) > 65536:
        raise SystemExit("Request too large")
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(25)
        sock.connect(os.environ.get("CRON_SERVICE_SOCKET", "/run/paperclip-cron-deploy/api.sock"))
        sock.sendall(call)
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(map(len, chunks)) > 1048576:
                raise SystemExit("Response too large")
    sys.stdout.buffer.write(b"".join(chunks))


if __name__ == "__main__":
    main()
