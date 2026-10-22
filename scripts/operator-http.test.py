#!/usr/bin/env python3
"""Synthetic request and process regression for operator HTTP commands."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
from threading import Event, Thread
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "scripts/operator-http.py"
PROCESS_VIEW = ROOT / "skills/paperclip/scripts/paperclip-processes.py"
DOCS = [ROOT / "doc" / name for name in (
    "MCP-ACCESS-GOVERNANCE.md", "MCP-RUNTIME-OPERATIONS.md", "MCP-DEMO-SCRIPT.md")]
SMOKES = [ROOT / "scripts/smoke" / name for name in (
    "hermes-gateway-join.sh", "hermes-gateway-e2e.sh")]


class MockHandler(BaseHTTPRequestHandler):
    entered = Event()
    release = Event()
    marker = ""
    seen_auth = ""
    seen_cookie = ""
    seen_gateway = ""
    seen_body = b""
    seen_origin = ""

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        type(self).seen_auth = self.headers.get("Authorization", "")
        type(self).seen_cookie = self.headers.get("Cookie", "")
        type(self).seen_gateway = self.headers.get("X-Paperclip-Tool-Gateway-Token", "")
        type(self).seen_origin = self.headers.get("Origin", "")
        type(self).seen_body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.entered.set()
        self.release.wait(timeout=5)
        if self.path == "/api/error":
            status, body = 401, self.marker.encode()
        elif self.path == "/api/redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/api/probe")
            self.end_headers()
            return
        elif self.path == "/api/events":
            status, body = 200, b"event: complete\ndata: {}\n\n"
        elif self.path == "/api/slow-events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(b"event: first\n\n")
                self.wfile.flush()
                time.sleep(0.6)
                self.wfile.write(b"event: second\n\n")
            except BrokenPipeError:
                pass
            return
        else:
            status, body = 200, b'{"ok":true}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class OperatorHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.marker = "eyJhbGciOiJub25lIn0." + secrets.token_urlsafe(18) + "." + secrets.token_urlsafe(18)
        marker_file = os.environ.get("MCP_ARGV_MARKER_FILE")
        if marker_file:
            path = Path(marker_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cls.marker)
            path.chmod(0o600)
        MockHandler.marker = cls.marker
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=5)
        cls.server.server_close()

    def setUp(self):
        MockHandler.entered.clear()
        MockHandler.release.set()
        MockHandler.seen_auth = ""
        MockHandler.seen_cookie = ""
        MockHandler.seen_gateway = ""
        MockHandler.seen_body = b""
        MockHandler.seen_origin = ""

    def env(self, path):
        return {
            **os.environ,
            "PAPERCLIP_URL": self.base,
            "PAPERCLIP_API_URL": self.base,
            "HERMES_GATEWAY_PROBE_URL": self.base,
            "OPERATOR_HTTP_URL": self.base + path,
            "BOARD_API_KEY": self.marker,
            "PAPERCLIP_API_KEY": self.marker,
            "HERMES_GATEWAY_API_KEY": self.marker,
            "GATEWAY_TOKEN": self.marker,
            "PAPERCLIP_AUTH_HEADER": "",
            "PAPERCLIP_COOKIE": "",
        }

    def invoke(self, path, *args, input=None, env=None):
        return subprocess.run(
            [sys.executable, "-B", str(CLIENT), *args],
            input=input, capture_output=True, env=env or self.env(path), timeout=10,
        )

    def test_board_post_reaches_mock_without_marker_in_argv_or_process_view(self):
        MockHandler.release.clear()
        body = b'{"probe":true}'
        process = subprocess.Popen(
            [sys.executable, "-B", str(CLIENT), "POST", "--auth", "board", "--body-stdin"],
            env=self.env("/api/probe"), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(body)
            process.stdin.close()
            process.stdin = None
            self.assertTrue(MockHandler.entered.wait(timeout=5))
            self.assertFalse(self.marker.encode() in Path(f"/proc/{process.pid}/cmdline").read_bytes())
            safe_view = subprocess.run(
                [sys.executable, "-B", str(PROCESS_VIEW)], capture_output=True, check=True, timeout=10,
            ).stdout
            self.assertFalse(self.marker.encode() in safe_view)
            self.assertFalse(self.marker.encode() in subprocess.run(
                ["ps", "-o", "args=", "-p", str(process.pid)], capture_output=True, check=True,
            ).stdout)
        finally:
            MockHandler.release.set()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(stdout, b'{"ok":true}')
        self.assertEqual(stderr, b"")
        self.assertTrue(MockHandler.seen_auth == "Bearer " + self.marker)
        self.assertEqual(MockHandler.seen_body, body)

    def test_legacy_curl_exposes_synthetic_marker(self):
        MockHandler.release.clear()
        process = subprocess.Popen(
            ["curl", "-fsS", "-H", "Authorization: Bearer " + self.marker, self.base + "/api/probe"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            self.assertTrue(MockHandler.entered.wait(timeout=5))
            self.assertTrue(self.marker.encode() in Path(f"/proc/{process.pid}/cmdline").read_bytes())
            self.assertTrue(self.marker.encode() in subprocess.run(
                ["ps", "-o", "args=", "-p", str(process.pid)], capture_output=True, check=True,
            ).stdout)
        finally:
            MockHandler.release.set()
        _stdout, _stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)

    def test_auth_variants_and_error_do_not_print_marker(self):
        for auth, header in (("paperclip", "seen_auth"), ("gateway", "seen_gateway"), ("hermes", "seen_auth")):
            with self.subTest(auth=auth):
                result = self.invoke("/api/probe", "GET", "--auth", auth)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'{"ok":true}')
                self.assertTrue(getattr(MockHandler, header).endswith(self.marker))
                self.assertFalse(self.marker.encode() in result.stderr)

        cookie_env = self.env("/api/probe")
        cookie_env["PAPERCLIP_API_KEY"] = ""
        cookie_env["PAPERCLIP_COOKIE"] = "session=" + self.marker
        result = self.invoke("/api/probe", "GET", "--auth", "paperclip", env=cookie_env)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(MockHandler.seen_cookie.endswith(self.marker))
        self.assertEqual(MockHandler.seen_origin, self.base)

        result = self.invoke("/api/error", "GET", "--auth", "board")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)
        self.assertTrue(b"401" in result.stderr)
        result = self.invoke("/api/redirect", "GET", "--auth", "board")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)

    def test_smoke_request_functions_reach_mock_with_auth_outside_argv(self):
        for script in SMOKES:
            with self.subTest(script=script.name):
                source = script.read_text()
                function = re.search(r"(?ms)^api_request\(\) \{\n.*?^\}", source)
                self.assertIsNotNone(function)
                env = self.env("/api/probe")
                env["HTTP_HELPER"] = str(CLIENT)
                env["API_BASE"] = self.base + "/api"
                command = function.group(0) + "\napi_request GET /probe\n[[ $RESPONSE_CODE == 200 ]]\napi_request POST /probe '{\"from\":\"smoke\"}'\n[[ $RESPONSE_CODE == 200 ]]\n"
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", command],
                                        env=env, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(MockHandler.seen_body, b'{"from":"smoke"}')
                self.assertTrue(MockHandler.seen_auth.endswith(self.marker))
                self.assertFalse(self.marker.encode() in result.stdout + result.stderr)

        source = SMOKES[1].read_text()
        function = re.search(r"(?ms)^gateway_request\(\) \{\n.*?^\}", source)
        self.assertIsNotNone(function)
        env = self.env("/api/probe")
        env["HTTP_HELPER"] = str(CLIENT)
        command = function.group(0) + "\ngateway_request GET /api/probe\n[[ $RESPONSE_CODE == 200 ]]\ngateway_request POST /api/probe '{\"from\":\"hermes\"}'\n[[ $RESPONSE_CODE == 200 ]]\n"
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", command],
                                env=env, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(MockHandler.seen_body, b'{"from":"hermes"}')
        self.assertTrue(MockHandler.seen_auth.endswith(self.marker))
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)

    def test_status_capture_stream_and_shell_wrapper(self):
        result = self.invoke("/api/error", "GET", "--auth", "board", "--allow-http-error", "--status-only")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"401\n")
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)
        result = self.invoke("/api/error", "GET", "--auth", "board", "--allow-http-error", "--append-status")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)
        self.assertTrue(result.stdout.endswith(b"401\n"))

        result = self.invoke("/api/events", "GET", "--auth", "hermes", "--stream")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"event: complete\ndata: {}\n\n")
        started = time.monotonic()
        result = self.invoke("/api/slow-events", "GET", "--auth", "hermes", "--stream", "--timeout", "0.1")
        self.assertEqual(result.returncode, 1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertIn(b"event: first", result.stdout)
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)

        env = self.env("/api/probe")
        env["MCP_TEST_BODY"] = '{"from":"shell"}'
        result = subprocess.run(
            ["bash", "-c", 'source scripts/operator-http.sh; board_api POST "$PAPERCLIP_URL/api/probe" "$MCP_TEST_BODY"'],
            cwd=ROOT, env=env, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(MockHandler.seen_body, env["MCP_TEST_BODY"].encode())
        self.assertFalse(self.marker.encode() in result.stdout + result.stderr)

    def test_targeted_docs_and_smokes_have_no_authenticated_curl(self):
        for path in DOCS:
            body = path.read_text()
            self.assertNotIn("curl -", body)
            self.assertIn("source scripts/operator-http.sh", body)
        for path in SMOKES:
            body = path.read_text()
            self.assertNotIn("AUTH_HEADERS", body)
            self.assertFalse(re.search(r"curl[^\n]*(?:Authorization|Cookie|Bearer|Tool-Gateway-Token)", body))
            self.assertIn("operator-http.py", body)
        e2e = SMOKES[1].read_text()
        self.assertIn("-e API_SERVER_KEY\n", e2e)
        self.assertNotIn('-e API_SERVER_KEY="$HERMES_GATEWAY_API_KEY"', e2e)
        self.assertNotIn('args+=(-e "${provider_key}=${!provider_key}")', e2e)
        self.assertNotIn('--arg token "$AGENT_API_KEY"', e2e)
        join = SMOKES[0].read_text()
        for unsafe in ('--arg apiKey "$HERMES_GATEWAY_API_KEY"',
                       '--arg secret "$CLAIM_SECRET"',
                       '--arg raw "$HERMES_GATEWAY_API_KEY"',
                       '--arg agentApiKey "$AGENT_API_KEY"'):
            self.assertNotIn(unsafe, join)


if __name__ == "__main__":
    unittest.main()
