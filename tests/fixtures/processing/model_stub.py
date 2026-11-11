"""Deterministic Ollama protocol fixture; never enabled in the application stack."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
calls = 0


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_json(200, {"models": [{"name": "synthetic-model:latest"}]} if self.path == "/api/tags" else {"calls": calls})

    def do_POST(self):
        global calls
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            calls += 1
            current = calls
        # Exhaust the legacy scoring function's two immediate attempts. The
        # worker must then return its delivery for a broker-managed retry.
        if current <= 2:
            self.send_json(503, {"error": "synthetic temporary outage"})
            return
        user = body["messages"][1]["content"]
        criteria = json.loads(user.split("КРИТЕРИИ_JSON:\n", 1)[1].split("\nСТОП_ФАКТОРЫ_JSON:", 1)[0])
        stops = json.loads(user.split("СТОП_ФАКТОРЫ_JSON:\n", 1)[1].split("\nРЕЗЮМЕ КАНДИДАТА:", 1)[0])
        result = {"assessments": [{"id": c["id"], "status": "met" if c["requirement"] == "Python" else "unknown",
            "evidence": ["Python"] if c["requirement"] == "Python" else []} for c in criteria],
            "stop_factors": [{"id": s["id"], "status": "unknown", "evidence": []} for s in stops]}
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
