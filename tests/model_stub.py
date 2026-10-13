"""Deterministic Ollama HTTP fixture for integration tests; never production."""
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

mode = "online"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global mode
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path == "/control":
            mode = data["mode"]
            self.reply(200, {"mode": mode})
            return
        if mode == "offline":
            self.reply(503, {"error": "Model offline"})
            return
        if mode == "timeout":
            import time
            time.sleep(5)
        if not data.get("format"):
            self.reply(200, {"message": {"content": "OK"}})
            return
        if mode == "invalid":
            self.reply(200, {"message": {"content": "invalid JSON"}})
            return
        prompt = data["messages"][-1]["content"]
        resume = prompt.split("РЕЗЮМЕ КАНДИДАТА:")[-1].casefold()
        match = re.search(r"Ключевые навыки: ([^\n]+)", prompt)
        words = match[1].split(", ") if match else []
        matched = [word for word in words if word.casefold() in resume]
        rating = {"score": round(100 * len(matched) / len(words), 2) if words else 0,
                  "matched_keywords": matched, "triggered_stop_factors": [],
                  "explanation": "Deterministic integration fixture"}
        self.reply(200, {"message": {"content": json.dumps(rating)}})

    def reply(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            pass


ThreadingHTTPServer(("0.0.0.0", 11434), Handler).serve_forever()
