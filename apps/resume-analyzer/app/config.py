"""Конфигурация сервиса из переменных окружения."""

import os


class Settings:
    # Ollama
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen3.5:9b")
    OLLAMA_TIMEOUT_SECONDS: float = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "180"))

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

settings = Settings()