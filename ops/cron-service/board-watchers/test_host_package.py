"""Synthetic boundary probes; all credentials and HTTP traffic are fixtures."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import disk_reporter
import github_api
import service_http
import verify_boundary


class Handler(BaseHTTPRequestHandler):
    calls = []

    def do_GET(self):
        self.calls.append((self.path, self.headers.get("Authorization")))
        if self.path.endswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/api/stolen")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, _format, *_args):
        pass


class HostPackageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR"))
        self.addCleanup(self.tmp.cleanup)

    def test_paperclip_transport_uses_private_fixture_and_refuses_redirect(self):
        token_file = Path(self.tmp.name) / "fixture.token"
        token_file.write_text("fixture-token\n")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        Handler.calls = []
        env = {"PAPERCLIP_API_URL": f"http://127.0.0.1:{server.server_port}",
               "PAPERCLIP_TOKEN_FILE": str(token_file)}
        with patch.dict(os.environ, env):
            self.assertEqual(service_http.request("GET", "/api/allowed"), {"ok": True})
            with self.assertRaises(Exception):
                service_http.request("GET", "/api/redirect")
        self.assertEqual([path for path, _auth in Handler.calls], ["/api/allowed", "/api/redirect"])
        self.assertTrue(all(auth == "Bearer fixture-token" for _path, auth in Handler.calls))

    def test_missing_credential_fails_before_http(self):
        with patch.dict(os.environ, {"PAPERCLIP_API_URL": "http://127.0.0.1:9",
                                     "PAPERCLIP_TOKEN_FILE": str(Path(self.tmp.name) / "missing") } ):
            with self.assertRaises(FileNotFoundError):
                service_http.request("GET", "/api/issues/fixed")

    def test_disk_socket_accepts_only_fixed_issue_and_uid(self):
        requests = []
        with patch.object(disk_reporter, "service_request", side_effect=lambda *args: requests.append(args) or {}):
            self.assertEqual(disk_reporter.report({"action": "note", "body":
                             "🟡 **Срабатывание дискового сторожа** fixture"}, 1000), {"local": True})
            self.assertEqual(requests, [])
            message = {"action": "escalate", "body": "🚨 **Эскалация дискового сторожа** fixture"}
            left, right = socket.socketpair()
            try:
                left.sendall(json.dumps(message).encode() + b"\n")
                disk_reporter.serve_one(right)
                self.assertEqual(json.loads(left.recv(256)), {"ok": True})
            finally:
                left.close()
                right.close()
            self.assertEqual(requests[0][0:2],
                             ("PATCH", f"/api/issues/{disk_reporter.SIGNAL_ISSUE}"))
            with self.assertRaises(ValueError):
                disk_reporter.report(message, 1001)
            with self.assertRaises(ValueError):
                disk_reporter.report({"action": "escalate", "body": message["body"],
                                      "issue": "other"}, 1000)
        self.assertEqual(len(requests), 1)

    def test_malformed_disk_client_is_denied_without_stopping_reporter(self):
        left, right = socket.socketpair()
        try:
            left.sendall(b"not-json\n")
            disk_reporter.serve_one(right)
            self.assertEqual(json.loads(left.recv(256))["ok"], False)
        finally:
            left.close()
            right.close()

    def test_github_reader_cannot_use_foreign_origin_or_path(self):
        for path in ("https://evil.example/", "repos/Other/repo/issues/1",
                     "repos/HelloPrintERP/helloprint-frontend/../../agents"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                github_api.get_json(path)

    def test_root_chain_accepts_system_binary_and_rejects_agent_tree(self):
        self.assertTrue(verify_boundary.root_owned_chain("/usr/bin/bash"))
        with self.assertRaises(ValueError):
            verify_boundary.root_owned_chain(__file__)

    def test_units_use_distinct_identities_and_root_owned_exec_paths(self):
        base = Path(__file__).parent
        units = sorted(base.glob("*.service"))
        self.assertEqual(len(units), 5)
        identities = set()
        for path in units:
            text = path.read_text()
            identity = path.stem
            self.assertIn(f"User={identity}\n", text)
            self.assertIn(f"Group={identity}\n", text)
            self.assertIn("WorkingDirectory=/opt/paperclip-cron\n", text)
            self.assertIn("ExecStart=/usr/bin/python3 /opt/paperclip-cron/", text)
            self.assertIn("ProtectHome=true\n", text)
            self.assertIn("UMask=0077\n", text)
            self.assertNotIn("/home/paperclip-user", text)
            identities.add(identity)
        self.assertEqual(len(identities), 5)
        for identity in ("pc-cron-watchdog", "pc-cron-quota"):
            text = (base.parent / f"paperclip-cron-{identity.removeprefix('pc-cron-')}.service").read_text()
            self.assertIn(f"User={identity}\n", text)
            self.assertIn("WorkingDirectory=/opt/paperclip-cron\n", text)
            self.assertIn("UMask=0077\n", text)


if __name__ == "__main__":
    unittest.main()
