"""Synthetic boundary probes; all credentials and HTTP traffic are fixtures."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import datetime
import json
import os
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import disk_reporter
import github_api
import pr1042
import pr1198
import pr923
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
            disk_reporter.report({"action": "escalate", "body":
                                 "🚨 **Disk CRITICAL** fixture"}, 1000)
            self.assertEqual(requests[1][0:2],
                             ("PATCH", f"/api/issues/{disk_reporter.SIGNAL_ISSUE}"))
            with self.assertRaises(ValueError):
                disk_reporter.report(message, 1001)
            with self.assertRaises(ValueError):
                disk_reporter.report({"action": "escalate", "body": message["body"],
                                      "issue": "other"}, 1000)
        self.assertEqual(len(requests), 2)

    def test_pr_wake_rechecks_after_an_uncertain_patch_response(self):
        with patch.object(pr923, "guard", side_effect=[{"status": "blocked"}, {"status": "todo"}]) as guard, \
                patch.object(pr923, "board_req", side_effect=OSError("response lost")) as board, \
                patch.object(pr923, "log"):
            self.assertTrue(pr923.wake("fixture", "head"))
            self.assertEqual(guard.call_count, 2)
            self.assertEqual(board.call_count, 1)
            self.assertEqual(board.call_args.args[0], "PATCH")

        def failed_patch(method, *_args):
            if method == "PATCH":
                raise OSError("response lost")
            return {}

        with patch.object(pr923, "guard", side_effect=[{"status": "blocked"}, {"status": "blocked"}]), \
                patch.object(pr923, "board_req", side_effect=failed_patch) as board, \
                patch.object(pr923, "log"):
            self.assertTrue(pr923.wake("fixture", "head"))
            self.assertEqual([call.args[0] for call in board.call_args_list], ["PATCH", "POST"])

    def test_pr_feedback_wakes_with_links_but_without_external_bodies(self):
        head = "a" * 40
        forbidden = "UNTRUSTED_FEEDBACK_BODY_DO_NOT_FORWARD"
        for watcher in (pr923, pr1198, pr1042):
            with self.subTest(watcher=watcher.__name__):
                base = f"repos/{watcher.REPO}"
                pr_path = f"{base}/pulls/{watcher.PR}"
                urls = [f"https://github.com/{watcher.REPO}/pull/{watcher.PR}#feedback-{i}"
                        for i in range(3)]
                feedback = [
                    {"id": i + 1, "user": {"login": "human-reviewer"},
                     "created_at": "2026-10-02T10:00:00Z", "submitted_at": "2026-10-02T10:00:00Z",
                     "state": "COMMENTED", "html_url": urls[i], "body": f"{forbidden}-{i}"}
                    for i in range(3)
                ]
                responses = {
                    pr_path: {"head": {"sha": head}, "state": "open", "draft": False,
                              "merged": False, "mergeable_state": "clean"},
                    f"{base}/commits/{head}": {"commit": {"author": {"name": "Fixture"}},
                                               "author": {"login": "fixture"}},
                    f"{base}/commits/{head}/check-runs?per_page=100": {"check_runs": []},
                    f"{pr_path}/commits?per_page=100": [
                        {"sha": head, "commit": {"author": {"name": "Fixture"},
                                                  "message": "Fixture commit"}}],
                    f"{base}/issues/{watcher.PR}/comments?per_page=100": [feedback[0]],
                    f"{pr_path}/reviews?per_page=100": [feedback[1]],
                    f"{pr_path}/comments?per_page=100": [feedback[2]],
                }
                with patch.object(watcher, "gh_json", side_effect=responses.__getitem__):
                    world = watcher.read_world()
                self.assertNotIn(forbidden, repr(world))

                state = {"seen": [], "head": head}
                wake_result = True if watcher is pr923 else "woke"
                with patch.object(watcher, "read_world", return_value=world), \
                        patch.object(watcher, "wake", return_value=wake_result) as wake, \
                        patch.object(watcher, "now", return_value=datetime.datetime(
                            2026, 10, 2, 12, tzinfo=datetime.timezone.utc)), \
                        patch.object(watcher, "log"):
                    watcher.tick(state)
                calls = [call for call in wake.call_args_list if call.args[1] == "feedback"]
                self.assertEqual(len(calls), 1)
                message = calls[0].args[0]
                self.assertNotIn(forbidden, message)
                for kind in ("коммент", "ревью", "строчный коммент"):
                    self.assertIn(f"- {kind}", message)
                self.assertIn("human-reviewer", message)
                self.assertIn("2026-10-02T10:00:00Z", message)
                self.assertIn("COMMENTED", message)
                for url in urls:
                    self.assertIn(url, message)
                self.assertEqual(len(state["seen"]), 3)

    def test_pr_head_and_merge_wakes_do_not_forward_commit_text(self):
        head = "a" * 40
        previous = "b" * 40
        merge_sha = "c" * 40
        forbidden = ("UNTRUSTED_AUTHOR_INSTRUCTION", "UNTRUSTED_SUBJECT_INSTRUCTION",
                     "UNTRUSTED_LOGIN_INSTRUCTION")
        for watcher in (pr923, pr1198, pr1042):
            events = ("head", "merged") if watcher is pr923 else ("head", "merged", "spoofed_head")
            for event in events:
                with self.subTest(watcher=watcher.__name__, event=event):
                    author = ("Database Engineer" if watcher is pr1198 else "Juliet (Builder)") \
                        if event == "spoofed_head" else forbidden[0]
                    base = f"repos/{watcher.REPO}"
                    pr_path = f"{base}/pulls/{watcher.PR}"
                    responses = {
                        pr_path: {"head": {"sha": head}, "state": "open", "draft": False,
                                  "merged": event == "merged", "merged_at": "2026-10-02T10:00:00Z",
                                  "merged_by": {"login": forbidden[2]}, "merge_commit_sha": merge_sha,
                                  "mergeable_state": "clean"},
                        f"{base}/commits/{head}": {
                            "commit": {"author": {"name": author}, "message": forbidden[1]},
                            "author": {"login": forbidden[2]}},
                        f"{base}/commits/{head}/check-runs?per_page=100": {"check_runs": []},
                        f"{pr_path}/commits?per_page=100": [
                            {"sha": watcher.APPROVED if watcher is pr923 else previous,
                             "commit": {"author": {"name": "Fixture"}, "message": "Fixture"}},
                            {"sha": head, "commit": {"author": {"name": author},
                                                     "message": forbidden[1]}}],
                        f"{base}/issues/{watcher.PR}/comments?per_page=100": [],
                        f"{pr_path}/reviews?per_page=100": [],
                        f"{pr_path}/comments?per_page=100": [],
                    }
                    with patch.object(watcher, "gh_json", side_effect=responses.__getitem__), \
                            patch.object(pr1042, "deployed", return_value=(True, merge_sha)):
                        world = watcher.read_world()

                    requests = []
                    assignee = watcher.ME if watcher is pr923 else watcher.ASSIGNEE

                    def board_req(method, path, payload=None):
                        requests.append((method, path, payload))
                        if method == "GET":
                            return {"status": "in_progress", "assigneeAgentId": assignee}
                        return {}

                    state = {"seen": [], "head": head if event == "merged" else previous}
                    with patch.object(watcher, "read_world", return_value=world), \
                            patch.object(watcher, "board_req", side_effect=board_req), \
                            patch.object(watcher, "now", return_value=datetime.datetime(
                                2026, 10, 2, 12, tzinfo=datetime.timezone.utc)), \
                            patch.object(watcher, "log"), patch.object(pr923, "blob", return_value="d" * 40):
                        watcher.tick(state)

                    writes = [payload for method, _path, payload in requests if method in ("POST", "PATCH")]
                    self.assertEqual(len(writes), 1)
                    message = json.dumps(writes[0], ensure_ascii=False)
                    for marker in forbidden:
                        self.assertNotIn(marker, json.dumps(requests, ensure_ascii=False))
                    self.assertIn(head[:9], message)
                    self.assertIn(f"https://github.com/{watcher.REPO}/commit/{head}", message)

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
