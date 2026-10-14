"""Model readiness is probed off the HTTP thread; liveness stays independent."""
import os
import threading
import time

from app.ollama_client import ask_ollama_chat, ModelUnavailable

INTERVAL = float(os.getenv("MODEL_PROBE_INTERVAL_SECONDS", "15"))
PROBE_TIMEOUT = float(os.getenv("MODEL_PROBE_TIMEOUT_SECONDS", "60"))
model_lock = threading.Lock()
_state_lock = threading.Lock()
_available = False
_checked_at = 0.0


def mark_ready(available: bool):
    global _available, _checked_at
    with _state_lock:
        _available = available
        _checked_at = time.monotonic()


def is_ready() -> bool:
    with _state_lock:
        return _available and (model_lock.locked() or
                               time.monotonic() - _checked_at < INTERVAL + PROBE_TIMEOUT + 10)


def monitor(stop: threading.Event):
    while not stop.is_set():
        if model_lock.acquire(blocking=False):
            try:
                ask_ollama_chat("Ответь кратко.", "Ответь OK.", num_ctx=16384,
                                max_tokens=8, timeout=PROBE_TIMEOUT)
                mark_ready(True)
            except ModelUnavailable:
                mark_ready(False)
            finally:
                model_lock.release()
        stop.wait(INTERVAL)
