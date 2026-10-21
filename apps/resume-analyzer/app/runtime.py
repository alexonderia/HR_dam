"""Process-local adapter state. The service runs exactly one Uvicorn worker."""

import threading

from app.config import settings

_lock = threading.Lock()
_state = {"broker_connected": False, "consumer_alive": False, "stopping": False, "busy": False}


def update_runtime(**changes):
    with _lock:
        _state.update(changes)


def runtime_status(model_ready: bool) -> dict:
    with _lock:
        state = dict(_state)
    native = settings.ANALYZER_ADAPTER == "amqp"
    alive = not state["stopping"] and (not native or state["consumer_alive"])
    return {"alive": alive, "adapter": settings.ANALYZER_ADAPTER,
            "broker_connected": state["broker_connected"] if native else None,
            "consumer_alive": state["consumer_alive"] if native else None,
            "model_ready": model_ready, "busy": state["busy"], "stopping": state["stopping"],
            "available": alive and model_ready and (not native or state["broker_connected"])}
