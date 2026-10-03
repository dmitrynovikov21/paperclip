#!/usr/bin/env python3
"""Credential boundary for an agent-UID cron. Run only as a dedicated service UID.

The Paperclip API enforces the cron_service key scope. This broker never returns
the key and never accepts a caller-selected upstream host or Authorization header.
"""

import json
import os
import socketserver
import stat
import urllib.error
import urllib.parse
import urllib.request

MAX_REQUEST = 65536
MAX_RESPONSE = 1048576


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            raw = self.rfile.readline(MAX_REQUEST + 1)
        except TimeoutError:
            return
        if not raw or len(raw) > MAX_REQUEST or not raw.endswith(b"\n"):
            return self.reply(413, {"error": "Invalid request size"})
        try:
            call = json.loads(raw)
            method = call["method"]
            path = call["path"]
            body = call.get("body")
            if method not in ("GET", "POST", "PATCH") or not isinstance(path, str):
                raise ValueError("Invalid method or path")
            parsed = urllib.parse.urlsplit(path)
            if (not path.startswith("/api/") or parsed.scheme or parsed.netloc
                    or parsed.query or parsed.fragment or "\\" in path):
                raise ValueError("Invalid API path")
            if method == "GET" and body is not None:
                raise ValueError("GET body is forbidden")
            if method != "GET" and not isinstance(body, dict):
                raise ValueError("JSON body required")
            payload = None if body is None else json.dumps(body, ensure_ascii=False).encode()
            request = urllib.request.Request(
                self.server.api_url + path, data=payload, method=method,
                headers={"Authorization": "Bearer " + self.server.api_key,
                         "Content-Type": "application/json"},
            )
            try:
                with self.server.opener.open(request, timeout=20) as response:
                    status, result = response.status, response.read(MAX_RESPONSE)
            except urllib.error.HTTPError as error:
                status, result = error.code, error.read(MAX_RESPONSE)
            self.reply(status, {"body": result.decode("utf-8", "replace")})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            self.reply(400, {"error": "Invalid request"})
        except Exception:
            # Do not reflect upstream exceptions: they may contain request headers.
            self.reply(502, {"error": "Upstream unavailable"})

    def reply(self, status, result):
        self.wfile.write((json.dumps({"status": status, **result}) + "\n").encode())


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, socket_path, api_url, api_key):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.opener = urllib.request.build_opener(NoRedirect())
        super().__init__(socket_path, Handler)


def main():
    api_url = os.environ["CRON_SERVICE_API_URL"].rstrip("/")
    socket_path = os.environ["CRON_SERVICE_SOCKET"]
    key_file = os.environ["CRON_SERVICE_TOKEN_FILE"]
    parsed = urllib.parse.urlsplit(api_url)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.path:
        raise SystemExit("Invalid fixed API URL")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Remote API URL must use HTTPS")
    metadata = os.lstat(key_file)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077):
        raise SystemExit("Service key must be a private regular file owned by this UID")
    with open(key_file, encoding="utf-8") as source:
        api_key = source.read().strip()
    if not api_key:
        raise SystemExit("Empty service key")
    os.umask(0o007)
    with Server(socket_path, api_url, api_key) as server:
        os.chmod(socket_path, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    main()
