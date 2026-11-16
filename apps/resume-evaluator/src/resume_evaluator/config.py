"""Evaluator settings; no legacy HTTP, callback, storage or adapter options."""

import math
import os


class Settings:
    OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3.5:4b")
    OLLAMA_TIMEOUT_SECONDS = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "180"))
    RANK_TIMEOUT_SECONDS = float(os.getenv("RANK_TIMEOUT_SECONDS", "840"))
    MODEL_PROBE_INTERVAL_SECONDS = float(os.getenv("MODEL_PROBE_INTERVAL_SECONDS", "15"))
    MODEL_PROBE_TIMEOUT_SECONDS = float(os.getenv("MODEL_PROBE_TIMEOUT_SECONDS", "10"))
    OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "16384"))
    OLLAMA_MAX_TOKENS = int(os.getenv("OLLAMA_MAX_TOKENS", "8192"))
    OLLAMA_CONTEXT_USAGE_RATIO = float(os.getenv("OLLAMA_CONTEXT_USAGE_RATIO", "0.9"))
    OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "5m")

    def validate(self):
        for name in ("OLLAMA_TIMEOUT_SECONDS", "RANK_TIMEOUT_SECONDS", "MODEL_PROBE_INTERVAL_SECONDS", "MODEL_PROBE_TIMEOUT_SECONDS"):
            value = getattr(self, name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if self.OLLAMA_NUM_CTX <= 0 or self.OLLAMA_MAX_TOKENS <= 0 or not 0 < self.OLLAMA_CONTEXT_USAGE_RATIO <= 1:
            raise ValueError("Invalid model context configuration")


settings = Settings()
