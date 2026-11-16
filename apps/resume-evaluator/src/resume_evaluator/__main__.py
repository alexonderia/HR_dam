from processing_runtime.worker import run
from .config import settings
from .evaluator import evaluate
from .readiness import is_ready, model_lock, monitor

if __name__ == "__main__":
    settings.validate()
    run("evaluate", evaluate, model_ready=is_ready, model_busy=model_lock.locked, model_monitor=monitor)
