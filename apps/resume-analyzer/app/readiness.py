
"""Model readiness is probed off the HTTP thread; liveness stays independent."""

import threading
import time
from contextlib import contextmanager

import requests

from app.ollama_client import OLLAMA_BASE_URL, MODEL
from app.ollama_client import ModelUnavailable
from app.config import settings
from app.runtime import update_runtime

INTERVAL = settings.MODEL_PROBE_INTERVAL_SECONDS
PROBE_TIMEOUT = settings.MODEL_PROBE_TIMEOUT_SECONDS

model_lock = threading.Lock()
_state_lock = threading.Lock()
_available = False
_checked_at = 0.0
_owner = threading.local()


class ModelBusy(ModelUnavailable):
    """Model capacity is occupied; this does not invalidate model readiness."""


def check_model_cancelled():
    callback = getattr(_owner, "check_cancelled", None)
    if callback:
        callback()


@contextmanager
def model_capacity(check_cancelled=None):
    # Pipeline and direct text analysis share the same limit, including nested calls.
    if getattr(_owner, "active", False):
        yield
        return
    if not is_ready():
        raise ModelUnavailable("Модель временно недоступна.")
    if not model_lock.acquire(timeout=PROBE_TIMEOUT + 5):
        raise ModelBusy("Модель занята.")
    try:
        if not is_ready():
            raise ModelUnavailable("Модель временно недоступна.")
        _owner.active = True
        _owner.check_cancelled = check_cancelled
        update_runtime(busy=True)
        yield
    finally:
        update_runtime(busy=False)
        _owner.active = False
        _owner.check_cancelled = None
        model_lock.release()


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
