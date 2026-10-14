"""
Настройка логирования для сервиса.

Два логгера:
- "app"            — краткие события процесса
- "app.diagnostic" — полные запросы/ответы модели

Логи выводятся в консоль (красиво, на русском) и в файлы (полный JSON).
"""

import json
import logging
import logging.handlers
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

LOG_DIR = Path(os.getenv("LOG_DIR", "logs"))
DIAGNOSTIC_DIR = LOG_DIR / "diagnostic"

DIAGNOSTIC_ENABLED = os.getenv("DIAGNOSTIC_LOGS_ENABLED", "false").lower() == "true"
DIAGNOSTIC_RETENTION_DAYS = int(os.getenv("DIAGNOSTIC_RETENTION_DAYS", "3"))


# ── Русские описания событий ────────────────────────────────────────────
EVENT_MESSAGES = {
    # Жизненный цикл задания
    "rank_job_started":              "🚀 Получен запрос на ранжирование резюме",
    "rank_job_completed":            "✅ Задание ранжирования завершено",
    "rank_job_invalid_requirements": "⚠️ Требования не прошли проверку (некорректный JSON)",
    "rank_job_file_read_failed":     "❌ Не удалось прочитать файл резюме",
    "rank_job_insufficient_text":    "⚠️ В файле слишком мало текста для анализа",

    # Извлечение текста
    "text_extraction_started":       "📄 Начато извлечение текста из резюме",
    "text_extraction_completed":     "📄 Извлечение текста завершено",
    "text_extraction_failed":        "❌ Не удалось извлечь текст из резюме",

    # Кэш
    "text_cache_hit":                "♻️ Текст резюме взят из кэша",
    "text_cache_miss":               "💾 Текст резюме сохранён в кэш",

    # Требования
    "requirements_parsed":           "📋 Требования распознаны",
    "file_received":                 "📎 Файл резюме получен",

    # Запросы к модели
    "ollama_request_started":        "🤖 Запрос к модели отправлен",
    "ollama_response_received":      "🤖 Ответ от модели получен",
    "ollama_request_timeout":        "⏱️ Таймаут запроса к модели",
    "ollama_request_failed":         "❌ Ошибка запроса к модели",
    "ollama_response_error":         "❌ Модель вернула ошибку",

    # Обработка профиля
    "profile_raw_score":             "📊 Оценка по профилю получена",
    "profile_ranked":                "📊 Итоговая оценка по профилю",
    "profile_parse_failed":          "⚠️ Не удалось разобрать ответ модели",
    "profile_attempt_failed":        "⚠️ Попытка оценки не удалась",
    "profile_ranking_failed":        "❌ Оценка по профилю не выполнена",

    # Контекст
    "context_overflow_detected":     "⚠️ Запрос не помещается в контекст — резюме будет обрезано",

    # Система
    "diagnostic_logging_enabled":    "🔍 Диагностическое логирование включено",
    "diagnostic_logging_disabled":   "🔇 Диагностическое логирование отключено",

    # Диагностические (полные данные)
    "requirements_full":             "[ДИАГ] Полный набор требований",
    "resume_text_extracted":         "[ДИАГ] Извлечённый текст резюме",
    "ollama_request_full":           "[ДИАГ] Полный запрос к модели",
    "ollama_response_full":          "[ДИАГ] Полный ответ модели",
}


class HumanFormatter(logging.Formatter):
    """Красивый форматтер для консоли: время | уровень | сообщение."""

    LEVEL_ICONS = {
        logging.DEBUG:    "🔎",
        logging.INFO:     "ℹ️ ",
        logging.WARNING:  "⚠️ ",
        logging.ERROR:    "❌",
        logging.CRITICAL: "💥",
    }

    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.now().strftime("%H:%M:%S")
        icon = self.LEVEL_ICONS.get(record.levelno, "ℹ️ ")

        # Пытаемся разобрать JSON-сообщение для красивого вывода
        try:
            data = json.loads(record.getMessage())
            event = data.get("event", "")
            message = EVENT_MESSAGES.get(event, event)

            # Собираем контекст (без служебных полей)
            skip_keys = {"event", "message"}
            context_parts = []
            for key, value in data.items():
                if key in skip_keys:
                    continue
                if value is None or value == "" or value == []:
                    continue
                context_parts.append(f"{key}={value}")

            context = " | ".join(context_parts)
            if context:
                return f"{timestamp} {icon} {message} [{context}]"
            return f"{timestamp} {icon} {message}"

        except (json.JSONDecodeError, AttributeError):
            # Не JSON — выводим как есть
            return f"{timestamp} {icon} {record.getMessage()}"


class JsonFormatter(logging.Formatter):
    """JSON-форматтер для файлов: полный структурированный вывод."""

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        try:
            data = json.loads(message)
            # Добавляем русское описание и метаданные
            event = data.get("event", "")
            data["message_ru"] = EVENT_MESSAGES.get(event, event)
            data["level"] = record.levelname
            data["timestamp"] = datetime.now().isoformat()
            return json.dumps(data, ensure_ascii=False)
        except (json.JSONDecodeError, AttributeError):
            return json.dumps({
                "message": message,
                "level": record.levelname,
                "timestamp": datetime.now().isoformat(),
            }, ensure_ascii=False)


def _ensure_dirs() -> None:
    """Создаёт директории для логов. При ошибке прав — продолжает работу."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        DIAGNOSTIC_DIR.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        pass


def setup_logging() -> None:
    """Инициализирует логгеры приложения."""
    _ensure_dirs()

    root_logger = logging.getLogger("app")
    root_logger.setLevel(logging.DEBUG)
    root_logger.propagate = False
    root_logger.handlers.clear()

    # ── Консоль: красивый человекочитаемый вывод ────────────────────────
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(HumanFormatter())
    root_logger.addHandler(console_handler)

    # ── Файл: полный JSON для анализа ───────────────────────────────────
    try:
        app_file_handler = logging.handlers.TimedRotatingFileHandler(
            LOG_DIR / "app.log",
            when="midnight",
            backupCount=14,
            encoding="utf-8",
        )
        app_file_handler.setLevel(logging.INFO)
        app_file_handler.setFormatter(JsonFormatter())
        root_logger.addHandler(app_file_handler)
        file_logging_ok = True
    except (PermissionError, OSError):
        file_logging_ok = False

    # ── Диагностический логгер ──────────────────────────────────────────
    diag_logger = logging.getLogger("app.diagnostic")
    diag_logger.setLevel(logging.DEBUG)
    diag_logger.propagate = False
    diag_logger.handlers.clear()

    if DIAGNOSTIC_ENABLED and file_logging_ok:
        try:
            diag_handler = logging.handlers.TimedRotatingFileHandler(
                DIAGNOSTIC_DIR / "diagnostic.log",
                when="midnight",
                backupCount=DIAGNOSTIC_RETENTION_DAYS,
                encoding="utf-8",
            )
            diag_handler.setLevel(logging.DEBUG)
            diag_handler.setFormatter(JsonFormatter())
            diag_logger.addHandler(diag_handler)
        except (PermissionError, OSError):
            diag_logger.addHandler(logging.NullHandler())
    else:
        diag_logger.addHandler(logging.NullHandler())


def get_logger(name: str = "app") -> logging.Logger:
    return logging.getLogger(name)


def get_diagnostic_logger() -> logging.Logger:
    return logging.getLogger("app.diagnostic")


def log_event(
    logger: logging.Logger,
    level: int,
    event: str,
    **fields: Any,
) -> None:
    """
    Унифицированный способ записи события.

    Пример:
        log_event(logger, logging.INFO, "profile_ranked",
                  job_id="...", profile_id="...", score=85.0)
    """
    record = {"event": event, **fields}
    logger.log(level, json.dumps(record, ensure_ascii=False, default=str))