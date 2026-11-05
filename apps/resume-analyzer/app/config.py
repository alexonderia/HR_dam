"""Конфигурация сервиса из переменных окружения."""

import os


def boolean_setting(name: str, default: bool) -> bool:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    if value not in ("true", "false"):
        raise ValueError(f"{name} must be true or false")
    return value == "true"


class Settings:
    ANALYZER_ADAPTER: str = os.getenv("ANALYZER_ADAPTER", "http")
    # Ollama
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen3.5:9b")
    OLLAMA_TIMEOUT_SECONDS: float = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "180"))
    RANK_TIMEOUT_SECONDS: float = float(os.getenv("RANK_TIMEOUT_SECONDS", "840"))
    MODEL_PROBE_INTERVAL_SECONDS: float = float(os.getenv("MODEL_PROBE_INTERVAL_SECONDS", "15"))
    MODEL_PROBE_TIMEOUT_SECONDS: float = float(os.getenv("MODEL_PROBE_TIMEOUT_SECONDS", "10"))

    # Контекст
    OLLAMA_NUM_CTX: int = int(os.getenv("OLLAMA_NUM_CTX", "16384"))
    OLLAMA_MAX_TOKENS: int = int(os.getenv("OLLAMA_MAX_TOKENS", "8192"))
    OLLAMA_CONTEXT_USAGE_RATIO: float = float(os.getenv("OLLAMA_CONTEXT_USAGE_RATIO", "0.9"))

    # Кэш
    TEXT_CACHE_MAX_ITEMS: int = int(os.getenv("TEXT_CACHE_MAX_ITEMS", "50"))

    OLLAMA_KEEP_ALIVE: str = os.getenv("OLLAMA_KEEP_ALIVE", "5m")
    TEXT_CACHE_MAX_BYTES: int = int(
        os.getenv("TEXT_CACHE_MAX_BYTES", str(20 * 1024 * 1024))
    )

        # RabbitMQ
    RABBITMQ_HOST: str = os.getenv("RABBITMQ_HOST", "rabbitmq")
    RABBITMQ_PORT: int = int(os.getenv("RABBITMQ_PORT", "5672"))
    RABBITMQ_USER: str = os.getenv("RABBITMQ_USER", "guest")
    RABBITMQ_PASSWORD: str = os.getenv("RABBITMQ_PASSWORD", "guest")
    RABBITMQ_VHOST: str = os.getenv("RABBITMQ_VHOST", "/")

    # Очереди
    RABBITMQ_ANALYSIS_QUEUE: str = "hr.resume.analysis"
    RABBITMQ_PROGRESS_QUEUE: str = "hr.resume.progress"
    RABBITMQ_RESULTS_QUEUE: str = "hr.resume.results"

    # Backend: обновление истёкших S3-ссылок
    BACKEND_BASE_URL: str = os.getenv(
        "BACKEND_BASE_URL",
        "http://backend:3001",
    )
    RESUME_ANALYZER_CALLBACK_TOKEN: str = os.getenv(
        "RESUME_ANALYZER_CALLBACK_TOKEN",
        "",
    )

    BACKEND_STATUS_TIMEOUT_SECONDS: float = float(
        os.getenv("BACKEND_STATUS_TIMEOUT_SECONDS", "10")
    )

    SHUTDOWN_GRACE_SECONDS: float = float(os.getenv("SHUTDOWN_GRACE_SECONDS", "210"))

    def validate(self):
        if self.ANALYZER_ADAPTER not in ("http", "amqp"):
            raise ValueError("ANALYZER_ADAPTER must be http or amqp")
        broker = boolean_setting("RABBITMQ_ENABLED", False)
        bridge = boolean_setting("RANK_BRIDGE_ENABLED", self.ANALYZER_ADAPTER == "http")
        if self.ANALYZER_ADAPTER == "amqp" and (bridge or not broker):
            raise ValueError("AMQP analyzer requires RABBITMQ_ENABLED=true and RANK_BRIDGE_ENABLED=false")
        if self.ANALYZER_ADAPTER == "http" and not bridge:
            raise ValueError("HTTP analyzer requires RANK_BRIDGE_ENABLED=true")
        if any(int(os.getenv(key, "1")) != 1 for key in ("WEB_CONCURRENCY", "UVICORN_WORKERS")):
            raise ValueError("Analyzer supports one process; multiple workers require external model coordination")
        if self.ANALYZER_ADAPTER == "amqp" and not self.RESUME_ANALYZER_CALLBACK_TOKEN:
            raise ValueError("AMQP analyzer requires RESUME_ANALYZER_CALLBACK_TOKEN")
        for key in ("OLLAMA_TIMEOUT_SECONDS", "RANK_TIMEOUT_SECONDS", "MODEL_PROBE_INTERVAL_SECONDS",
                    "MODEL_PROBE_TIMEOUT_SECONDS", "SHUTDOWN_GRACE_SECONDS"):
            if not 0 < getattr(self, key) < float("inf"):
                raise ValueError(f"{key} must be finite and positive")

settings = Settings()
