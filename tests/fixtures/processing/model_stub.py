"""Deterministic Ollama protocol fixture; never enabled in the application stack."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
calls = 0
available = True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/tags" and not available:
            self.send_json(503, {"error": "synthetic outage"})
            return
        self.send_json(200, {"models": [{"name": "synthetic-model:latest"}]} if self.path == "/api/tags" else {"calls": calls})

    def do_POST(self):
        global calls, available
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/control":
            available = body["available"]
            self.send_json(200, {"available": available})
            return
        with lock:
            calls += 1
            current = calls
        # Exhaust the legacy scoring function's two immediate attempts. The
        # worker must then return its delivery for a broker-managed retry.
        if not available or current <= 2:
            self.send_json(503, {"error": "synthetic temporary outage"})
            return
        user = body["messages"][1]["content"]
        user = json.loads(user)
        criteria, stops = user["criteria"], user["stop_factors"]
        result = {"assessments": [{"id": c["id"], "status": "met" if c["requirement"] == "Python" else "unknown",
            "evidence": ["Python"] if c["requirement"] == "Python" else [],
            "unknown_reason": None if c["requirement"] == "Python" else "not_stated", "partial_reason": None} for c in criteria],
            "stop_factors": [{"id": s["id"], "status": "unknown", "evidence": [], "unknown_reason": "not_stated"} for s in stops]}
        self.send_json(200, {"model": "synthetic-model:latest", "done": True,
            "message": {"role": "assistant", "content": json.dumps(result)}})

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


ThreadingHTTPServer(("0.0.0.0", 11434), Handler).serve_forever()
