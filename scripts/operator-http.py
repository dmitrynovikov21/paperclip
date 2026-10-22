#!/usr/bin/env python3
"""Operator HTTP request without credentials, request bodies, or secret URLs in argv."""

import argparse
import http.client
import os
from pathlib import Path
import select
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def origin(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.fragment:
        raise ValueError("invalid HTTP URL")
    return parts.scheme, parts.hostname, parts.port


def header_value(value):
    if any(character in value for character in "\r\n\0"):
        raise ValueError("invalid HTTP header")
    return value


def auth_headers(kind, url):
    headers = {}
    if kind in ("board", "paperclip", "gateway"):
        base = os.environ.get("PAPERCLIP_URL" if kind in ("board", "gateway") else "PAPERCLIP_API_URL", "")
        if not base or origin(url) != origin(base):
            raise ValueError("Paperclip request origin mismatch")
        if not urlsplit(url).path.startswith("/api/"):
            raise ValueError("Paperclip request path must be under /api/")
    elif kind == "hermes":
        base = os.environ.get("HERMES_GATEWAY_PROBE_URL", "")
        if not base or origin(url) != origin(base):
            raise ValueError("Hermes request origin mismatch")

    if kind == "board":
        key = os.environ.get("BOARD_API_KEY", "")
        if not key:
            raise ValueError("BOARD_API_KEY is required")
        headers["Authorization"] = "Bearer " + header_value(key)
    elif kind == "paperclip":
        auth = os.environ.get("PAPERCLIP_AUTH_HEADER", "")
        key = os.environ.get("PAPERCLIP_API_KEY", "")
        cookie = os.environ.get("PAPERCLIP_COOKIE", "")
        if auth:
            headers["Authorization"] = header_value(auth)
        elif key:
            headers["Authorization"] = "Bearer " + header_value(key)
        if cookie:
            headers["Cookie"] = header_value(cookie)
            browser_origin = os.environ.get("PAPERCLIP_BROWSER_ORIGIN") or base
            origin(browser_origin)
            browser_origin = header_value(browser_origin.rstrip("/"))
            headers["Origin"] = browser_origin
            headers["Referer"] = browser_origin + "/"
    elif kind == "gateway":
        token = os.environ.get("GATEWAY_TOKEN", "")
        if not token:
            raise ValueError("GATEWAY_TOKEN is required")
        headers["X-Paperclip-Tool-Gateway-Token"] = header_value(token)
    elif kind == "hermes":
        key = os.environ.get("HERMES_GATEWAY_API_KEY", "")
        if not key:
            raise ValueError("HERMES_GATEWAY_API_KEY is required")
        headers["Authorization"] = "Bearer " + header_value(key)
    return headers


def redact_error_body(body):
    # Expected policy denials have useful JSON bodies, but an upstream may echo
    # credentials on an error path. Keep those values out of stdout and files.
    for name in ("BOARD_API_KEY", "PAPERCLIP_API_KEY", "PAPERCLIP_AUTH_HEADER",
                 "PAPERCLIP_COOKIE", "GATEWAY_TOKEN", "HERMES_GATEWAY_API_KEY"):
        value = os.environ.get(name, "")
        if value:
            body = body.replace(value.encode(), b"[redacted]")
            if value.startswith("Bearer "):
                body = body.replace(value[7:].encode(), b"[redacted]")
            if name == "PAPERCLIP_COOKIE" and "=" in value:
                body = body.replace(value.split("=", 1)[1].encode(), b"[redacted]")
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"))
    parser.add_argument("--auth", choices=("board", "paperclip", "gateway", "hermes", "none"), required=True)
    parser.add_argument("--body-stdin", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--status-only", action="store_true")
    parser.add_argument("--append-status", action="store_true")
    parser.add_argument("--allow-http-error", action="store_true")
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if args.status_only and args.append_status:
        parser.error("--status-only and --append-status are mutually exclusive")

    try:
        url = os.environ.get("OPERATOR_HTTP_URL", "")
        origin(url)
        if args.body_stdin and args.method in ("GET", "HEAD"):
            raise ValueError("GET/HEAD cannot have a request body")
        body = sys.stdin.buffer.read() if args.body_stdin else None
        headers = auth_headers(args.auth, url)
        if args.body_stdin:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=args.method)
        try:
            response = build_opener(NoRedirect).open(request, timeout=args.timeout)
        except HTTPError as error:
            response = error
        with response:
            code = response.status
            if not 200 <= code < 300 and not args.allow_http_error:
                print(f"Operator HTTP returned {code}", file=sys.stderr)
                return 1
            if args.output or not args.status_only:
                target = args.output.open("wb") if args.output else sys.stdout.buffer
                try:
                    if args.stream and 200 <= code < 300:
                        deadline = time.monotonic() + args.timeout
                        while True:
                            if response.isclosed():
                                break
                            remaining = deadline - time.monotonic()
                            if remaining <= 0 or not select.select([response], [], [], remaining)[0]:
                                raise TimeoutError("stream deadline exceeded")
                            chunk = response.read1(4096)
                            if not chunk:
                                break
                            target.write(chunk)
                            target.flush()
                    else:
                        payload = response.read()
                        target.write(redact_error_body(payload) if not 200 <= code < 300 else payload)
                finally:
                    if args.output:
                        target.close()
            if args.status_only:
                print(code)
            elif args.append_status:
                print(f"\n{code}")
        return 0
    except (URLError, OSError, ValueError, TimeoutError, http.client.HTTPException) as error:
        # Exception text can contain a credential-bearing URL; keep it out of logs.
        print(f"Operator HTTP request failed ({type(error).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
