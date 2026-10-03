"""Synthetic broker smoke: fixed upstream, no key disclosure, no redirects."""

import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

HERE = Path(__file__).resolve().parent


class Upstream(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.seen.append((self.path, self.headers.get("Authorization")))
        if self.path == "/api/redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/steal")
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


class Proxy(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.seen.append(self.path)
        self.send_response(502)
        self.end_headers()


class BrokerTest(unittest.TestCase):
    def test_credential_remains_in_broker_and_redirect_is_not_followed(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")) as directory:
            secret = "synthetic-service-key"
            token_file = Path(directory, "token")
            token_file.write_text(secret)
            token_file.chmod(0o400)
            socket_path = str(Path(directory, "api.sock"))
            upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
            thread = threading.Thread(target=upstream.serve_forever, daemon=True)
            thread.start()
            proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            environment = {
                **os.environ,
                "CRON_SERVICE_API_URL": f"http://127.0.0.1:{upstream.server_port}",
                "CRON_SERVICE_SOCKET": socket_path,
                "CRON_SERVICE_TOKEN_FILE": str(token_file),
                "http_proxy": f"http://127.0.0.1:{proxy.server_port}",
                "HTTP_PROXY": f"http://127.0.0.1:{proxy.server_port}",
                "no_proxy": "",
                "NO_PROXY": "",
            }
            broker = subprocess.Popen(["python3", str(HERE / "api_broker.py")], env=environment)
            try:
                for _ in range(100):
                    if Path(socket_path).exists():
                        break
                    threading.Event().wait(0.02)
                self.assertTrue(Path(socket_path).exists(), "broker did not start")

                def call(path):
                    result = subprocess.run(
                        ["python3", str(HERE / "api_client.py"), "GET", path],
                        env=environment, capture_output=True, text=True, check=True,
                    )
                    self.assertNotIn(secret, result.stdout + result.stderr)
                    return json.loads(result.stdout)

                self.assertEqual(call("/api/allowed"), {"status": 200, "body": '{"ok":true}'})
                self.assertEqual(call("/api/redirect")["status"], 302)
                self.assertEqual(call("//example.test/steal")["status"], 400)
                self.assertEqual(Upstream.seen, [
                    ("/api/allowed", "Bearer " + secret),
                    ("/api/redirect", "Bearer " + secret),
                ])
                self.assertEqual(Proxy.seen, [])
            finally:
                broker.terminate()
                broker.wait(timeout=5)
                upstream.shutdown()
                upstream.server_close()
                proxy.shutdown()
                proxy.server_close()
                Upstream.seen.clear()
                Proxy.seen.clear()


if __name__ == "__main__":
    unittest.main()
