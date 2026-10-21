#!/usr/bin/env python3
"""Call the current Paperclip API without putting credentials or JSON in argv."""

import argparse
import http.client
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    """Keep the bearer header on the configured origin only."""

    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def endpoint(path: str):
    base = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    if base.endswith("/api"):
        base = base[:-4]
    origin = urlsplit(base)
    relative = urlsplit(path)
    if (
        origin.scheme not in ("http", "https")
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.query
        or origin.fragment
        or relative.scheme
        or relative.netloc
        or relative.fragment
        or not (
            relative.path == "/api"
            or relative.path.startswith("/api/")
            or relative.path.startswith("/llms/")
        )
        or "/../" in relative.path
    ):
        raise ValueError("expected PAPERCLIP_API_URL and a local /api path")
    return urlsplit(base + path)


def headers(method: str, content_type: str | None):
    key = os.environ.get("PAPERCLIP_API_KEY")
    if not key and os.environ.get("PAPERCLIP_AGENT_ID"):
        raise ValueError("PAPERCLIP_API_KEY is required")
    result = {"Authorization": "Bearer " + key} if key else {}
    if method not in ("GET", "HEAD"):
        run_id = os.environ.get("PAPERCLIP_RUN_ID")
        if not run_id and os.environ.get("PAPERCLIP_AGENT_ID"):
            raise ValueError("PAPERCLIP_RUN_ID is required for mutations")
        if run_id:
            result["X-Paperclip-Run-Id"] = run_id
    if content_type:
        result["Content-Type"] = content_type
    return result


def upload_file(url, method: str, path: Path, content_type: str):
    boundary = "paperclip-" + secrets.token_hex(16)
    filename = re.sub(r"[^A-Za-z0-9._ -]", "_", path.name)
    if "\r" in content_type or "\n" in content_type:
        raise ValueError("invalid multipart content type")
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    suffix = f"\r\n--{boundary}--\r\n".encode()
    request_headers = headers(method, f"multipart/form-data; boundary={boundary}")
    request_headers["Content-Length"] = str(len(prefix) + path.stat().st_size + len(suffix))
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=30)
    try:
        target = url.path + (("?" + url.query) if url.query else "")
        connection.putrequest(method, target)
        for name, value in request_headers.items():
            connection.putheader(name, value)
        connection.endheaders()
        connection.send(prefix)
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                connection.send(chunk)
        connection.send(suffix)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"))
    parser.add_argument("path", help="same-server /api or /llms path; external URLs are refused")
    payload = parser.add_mutually_exclusive_group()
    payload.add_argument("--body-stdin", action="store_true", help="read JSON request body from stdin")
    payload.add_argument("--multipart-file", type=Path, help="stream an artifact as multipart file")
    parser.add_argument("--content-type", default="application/octet-stream", help="MIME type for multipart file")
    parser.add_argument("--discard-response", action="store_true", help="do not print response content")
    args = parser.parse_args()

    try:
        url = endpoint(args.path)
        if args.multipart_file:
            if args.method != "POST":
                raise ValueError("multipart uploads require POST")
            status, response = upload_file(url, args.method, args.multipart_file, args.content_type)
        else:
            if args.body_stdin and args.method in ("GET", "HEAD"):
                raise ValueError("GET/HEAD cannot have a request body")
            body = sys.stdin.buffer.read() if args.body_stdin else (b"" if args.method == "POST" else None)
            request = Request(
                url.geturl(),
                data=body,
                headers=headers(args.method, "application/json" if args.body_stdin else None),
                method=args.method,
            )
            with build_opener(NoRedirect).open(request, timeout=30) as result:
                status, response = result.status, result.read()
        if not (200 <= status < 300):
            print(f"Paperclip API returned HTTP {status}", file=sys.stderr)
            return 1
        if not args.discard_response:
            sys.stdout.buffer.write(response)
        return 0
    except HTTPError as error:
        print(f"Paperclip API returned HTTP {error.code}", file=sys.stderr)
    except (URLError, OSError, ValueError, http.client.HTTPException) as error:
        # The exception is deliberately not echoed: it may contain a URL or header.
        print(f"Paperclip API request failed ({type(error).__name__})", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
