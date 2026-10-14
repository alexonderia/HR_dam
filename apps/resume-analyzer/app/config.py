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


settings = Settings()