"""A stand-in for Apple's push service on 127.0.0.1, to see what LoomWatch pushes to a paired iPhone.

Start LoomWatch with LOOMWATCH_APNS_URL=http://127.0.0.1:<port> and a push key made for the trial
(`loomwatchd push-key set`, any P-256 .p8 file). Each push is answered 200, as Apple answers one it
took, and written to <log> as one JSON line: its token, push type, topic, priority, collapse id and
body. A push to the token "gone" is answered 410, as Apple answers for an app that was removed.

With SIM set to a simulator's id (`xcrun simctl list devices`), each app push (an alert, or a
silent one that wakes the app) is also handed to that simulator's LoomWatch with `xcrun simctl
push`. A Live Activity's own pushes are only written down: `simctl` delivers app pushes alone.

Usage: python3 scripts/mock-apns.py [port] [log]   (default 4300, ./pushes.jsonl)
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4300
LOG = sys.argv[2] if len(sys.argv) > 2 else "pushes.jsonl"
SIM = os.environ.get("SIM")
APP = os.environ.get("APP", "loomwatch.phone")


class Apple(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        token = self.path.rsplit("/", 1)[-1]
        push = {
            "token": token,
            "type": self.headers.get("apns-push-type"),
            "topic": self.headers.get("apns-topic"),
            "priority": self.headers.get("apns-priority"),
            "collapse": self.headers.get("apns-collapse-id"),
            "body": json.loads(body or b"{}"),
        }
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(push) + "\n")
        if token == "gone":
            return self.answer(410, {"reason": "Unregistered"})
        if SIM and push["type"] in ("alert", "background"):
            subprocess.run(["xcrun", "simctl", "push", SIM, APP, "-"], input=body, check=False)
        self.answer(200, None)

    def answer(self, status, body):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Apple's push service stands in on http://127.0.0.1:{PORT}, writing to {LOG}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Apple).serve_forever()
