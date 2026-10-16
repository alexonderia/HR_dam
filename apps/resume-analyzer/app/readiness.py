
"""Model readiness is probed off the HTTP thread; liveness stays independent."""

import os
import threading
import time

import requests

from app.ollama_client import OLLAMA_BASE_URL, MODEL

INTERVAL = float(os.getenv("MODEL_PROBE_INTERVAL_SECONDS", "15"))
PROBE_TIMEOUT = float(os.getenv("MODEL_PROBE_TIMEOUT_SECONDS", "10"))

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
        return _available and (
            model_lock.locked()
            or time.monotonic() - _checked_at < INTERVAL + PROBE_TIMEOUT + 10
        )


def _probe_model() -> bool:
    """Check that Ollama responds and the configured model is available."""
    response = requests.get(
        f"{OLLAMA_BASE_URL}/api/tags",
        timeout=PROBE_TIMEOUT,
    )
    response.raise_for_status()

    data = response.json()
    if not isinstance(data, dict):
        return False

    models = data.get("models", [])
    if not isinstance(models, list):
        return False

    expected = MODEL
    if ":" not in expected.rsplit("/", 1)[-1]:
        expected = f"{expected}:latest"

    return any(
        isinstance(model, dict)
        and model.get("name") in {MODEL, expected}
        for model in models
    )


def monitor(stop: threading.Event):
    while not stop.is_set():
        if model_lock.acquire(blocking=False):
            try:
                mark_ready(_probe_model())
            except (requests.RequestException, ValueError):
                mark_ready(False)
            finally:
                model_lock.release()

        stop.wait(INTERVAL)
