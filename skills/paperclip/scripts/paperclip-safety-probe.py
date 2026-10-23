#!/usr/bin/env python3
"""RED/GREEN argv probe and transcript/run-log verification with a synthetic token.

The synthetic token is generated at runtime. Only pass a marker-file path in
PAPERCLIP_RUN_SCRATCH_DIR; never put a real credential or marker on the CLI.
"""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from threading import Event, Thread
from urllib.request import Request, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent


class ProbeHandler(BaseHTTPRequestHandler):
    entered = Event()
    release = Event()
    expected_token = ""
    expected_body = None
    received_valid_request = False

    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).received_valid_request = (
            self.headers.get("Authorization") == "Bearer " + self.expected_token
            and (self.expected_body is None or body == self.expected_body)
        )
        self.entered.set()
        self.release.wait(timeout=10)
        response = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def argv_of(pid: int) -> bytes:
    return Path(f"/proc/{pid}/cmdline").read_bytes()


def check_request(command, marker: str, env, body=None):
    ProbeHandler.entered.clear()
    ProbeHandler.release.clear()
    ProbeHandler.received_valid_request = False
    process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE if body else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        if body is not None:
            process.stdin.write(body)
            process.stdin.close()
            process.stdin = None
        if not ProbeHandler.entered.wait(timeout=5):
            raise RuntimeError("mock API was not reached")
        argv_has_marker = marker.encode() in argv_of(process.pid)
        raw_ps = subprocess.run(["ps", "-eo", "pid,etime,args"], env=env,
                                capture_output=True, check=True).stdout
        raw_ps_has_marker = marker.encode() in raw_ps
        safe_comm = subprocess.run([sys.executable, SCRIPT_DIR / "paperclip-processes.py"],
                                   env=env, capture_output=True, check=True).stdout
        safe_output_has_marker = marker.encode() in safe_comm
    finally:
        ProbeHandler.release.set()
    output, errors = process.communicate(timeout=5)
    if process.returncode or not ProbeHandler.received_valid_request or marker.encode() in output + errors:
        raise RuntimeError("API request did not complete cleanly")
    return argv_has_marker, raw_ps_has_marker, safe_output_has_marker


def check_bearer_option(marker: str, env):
    """A bearer in another process's argv must never reach diagnostic output."""
    command = [sys.executable, "-c", "import time; time.sleep(10)", "--bearer-token=" + marker]
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        if marker.encode() not in argv_of(process.pid):
            raise RuntimeError("synthetic bearer process was not visible in argv")
        safe_output = subprocess.run(
            [sys.executable, SCRIPT_DIR / "paperclip-processes.py"],
            env=env, capture_output=True, check=True,
        ).stdout
        rows = [row.split() for row in safe_output.splitlines()[1:]]
        if not any(row and row[0] == str(process.pid).encode() for row in rows):
            raise RuntimeError("synthetic bearer process was not listed")
        if marker.encode() in safe_output:
            raise RuntimeError("safe process output exposed synthetic bearer")
        unsupported = subprocess.run(
            [sys.executable, SCRIPT_DIR / "paperclip-processes.py", "--args=" + marker],
            env=env, capture_output=True, check=False,
        )
        if unsupported.returncode == 0 or marker.encode() in unsupported.stdout + unsupported.stderr:
            raise RuntimeError("full-argv diagnostic was accepted or exposed synthetic bearer")
    finally:
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=5)


def probe(marker_file: Path, live_path: str | None):
    # JWT-shaped, but generated locally and accepted only by the mock server.
    marker = "eyJhbGciOiJub25lIn0." + secrets.token_urlsafe(18) + "." + secrets.token_urlsafe(18)
    marker_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker_file.write_text(marker)
    marker_file.chmod(0o600)

    ProbeHandler.expected_token = marker
    server = ThreadingHTTPServer(("127.0.0.1", 0), ProbeHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    synthetic_env = os.environ.copy()
    synthetic_env.update(PAPERCLIP_API_URL=base, PAPERCLIP_API_KEY=marker,
                         PAPERCLIP_RUN_ID="synthetic-run-id")
    try:
        ProbeHandler.expected_body = None
        red = check_request(["curl", "-sS", "-H", "Authorization: Bearer " + marker,
                             base + "/api/probe"], marker, synthetic_env)
        if red != (True, True, False):
            raise RuntimeError("RED baseline or safe process output failed")
        check_bearer_option(marker, synthetic_env)

        ProbeHandler.expected_body = b'{"probe":true}'
        command = [sys.executable, str(SCRIPT_DIR / "paperclip-api.py"), "POST", "/api/probe", "--body-stdin"]
        # check_request needs a dedicated environment for the synthetic client.
        ProbeHandler.entered.clear()
        ProbeHandler.release.clear()
        ProbeHandler.received_valid_request = False
        process = subprocess.Popen(command, env=synthetic_env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(ProbeHandler.expected_body)
            process.stdin.close()
            process.stdin = None
            if not ProbeHandler.entered.wait(timeout=5):
                raise RuntimeError("argv-free client did not reach mock API")
            green_argv = marker.encode() not in argv_of(process.pid)
            safe_comm = subprocess.run([sys.executable, SCRIPT_DIR / "paperclip-processes.py"],
                                       env=synthetic_env, capture_output=True, check=True).stdout
            green_ps = marker.encode() not in safe_comm
        finally:
            ProbeHandler.release.set()
        output, errors = process.communicate(timeout=5)
        if not (green_argv and green_ps and ProbeHandler.received_valid_request
                and process.returncode == 0 and output == b'{"ok":true}'
                and marker.encode() not in errors):
            raise RuntimeError("GREEN argv-free API request failed")

        print("RED: legacy curl bearer was visible in argv and raw ps capture")
        print("GREEN: argv-free API request passed; safe process output omitted marker")
        print("BEARER OPTION: process listed without token; full-argv mode rejected")
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    if live_path:
        result = subprocess.run([sys.executable, SCRIPT_DIR / "paperclip-api.py", "GET", live_path,
                                 "--discard-response"], capture_output=True, check=False)
        if result.returncode or result.stdout or marker.encode() in result.stderr:
            raise RuntimeError("live Paperclip API call failed")
        print("LIVE: authenticated Paperclip API call passed")


def verify(marker_file: Path, transcript: Path):
    marker = marker_file.read_bytes()
    transcript_bytes = transcript.read_bytes()
    if not marker or not transcript_bytes:
        raise RuntimeError("marker file and raw transcript must be nonempty")
    transcript_hits = transcript_bytes.count(marker)

    base = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    if base.endswith("/api"):
        base = base[:-4]
    run_id = os.environ["PAPERCLIP_RUN_ID"]
    offset = 0
    log_hits = 0
    total_content_bytes = 0
    for _ in range(200):
        url = base + f"/api/heartbeat-runs/{run_id}/log?offset={offset}&limitBytes=1048576"
        request = Request(url, headers={"Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"]})
        with urlopen(request, timeout=30) as response:
            page = json.load(response)
        log_hits += json.dumps(page).encode().count(marker)
        content = page.get("content", "")
        content_bytes = content.encode() if isinstance(content, str) else json.dumps(content).encode()
        total_content_bytes += len(content_bytes)
        next_offset = page.get("nextOffset", offset)
        if next_offset <= offset:
            break
        offset = next_offset
    else:
        raise RuntimeError("run-log exceeded bounded scan")

    if not total_content_bytes:
        raise RuntimeError("stored run-log is empty; cannot verify recorded output")
    print(f"RAW TRANSCRIPT: {transcript_hits} marker matches in {len(transcript_bytes)} bytes")
    print(f"STORED RUN-LOG: {log_hits} marker matches in {total_content_bytes} content bytes")
    if transcript_hits or log_hits:
        raise RuntimeError("synthetic marker escaped into a recorded output")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("probe", "verify"))
    parser.add_argument("--marker-file", type=Path, required=True)
    parser.add_argument("--live-path", help="real Paperclip GET path for probe mode")
    parser.add_argument("--transcript", type=Path, help="raw Codex JSONL for verify mode")
    args = parser.parse_args()
    if args.mode == "probe":
        probe(args.marker_file, args.live_path)
    elif args.transcript:
        verify(args.marker_file, args.transcript)
    else:
        parser.error("verify mode requires --transcript")


if __name__ == "__main__":
    main()
