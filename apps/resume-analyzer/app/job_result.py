
"""Формирование сообщений RabbitMQ по контракту."""

from datetime import datetime, timezone

from app.analysis_service import InsufficientResumeTextError
from app.document_loader import (
    DocumentDownloadError,
    DocumentIntegrityError,
    DownloadLinkError,
)
from app.job_processor import JobValidationError
from app.ollama_client import (
    ModelUnavailable,
    ModelTimeout,
    ModelResponseError,
)


def envelope(job: dict) -> dict:
    """Общие поля всех сообщений."""

    return {
        "version": job["version"],
        "job_id": job["job_id"],
        "batch_id": job["batch_id"],
        "item_id": job["item_id"],
        "attempt": job["attempt"],
    }


def processing_event(job: dict) -> dict:
    """Событие начала обработки."""

    return {
        **envelope(job),
        "stage": "processing",
        "created_at": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
    }


def classify_error(exc: Exception) -> tuple[str, bool]:
    """
    Возвращает:
    - код ошибки;
    - можно ли повторить обработку.
    """

    if isinstance(exc, DocumentIntegrityError):
        return "DOCUMENT_INTEGRITY_ERROR", False

    if isinstance(exc, DocumentDownloadError):
        return "DOCUMENT_DOWNLOAD_ERROR", False

    if isinstance(exc, DownloadLinkError):
        return "DOWNLOAD_LINK_ERROR", False

    if isinstance(exc, ModelUnavailable):
        return "MODEL_UNAVAILABLE", True

    if isinstance(exc, ModelTimeout):
        return "MODEL_TIMEOUT", True

    if isinstance(exc, ModelResponseError):
        return "MODEL_RESPONSE_ERROR", True

    if isinstance(exc, InsufficientResumeTextError):
        return "TEXT_EXTRACTION_FAILED", False

    if isinstance(exc, (JobValidationError, ValueError)):
        return "INVALID_JOB", False

    return "INTERNAL_ERROR", True


def failed_result(job: dict, exc: Exception) -> dict:
    """Формирует безопасное сообщение об ошибке."""

    code, _ = classify_error(exc)

    # Не отправляем наружу str(exc):
    # там могут оказаться внутренние URL,
    # параметры подключения или текст резюме.
    messages = {
        "DOCUMENT_INTEGRITY_ERROR": "Документ не прошёл проверку целостности.",
        "DOCUMENT_DOWNLOAD_ERROR": "Не удалось скачать документ.",
        "DOWNLOAD_LINK_ERROR": "Не удалось получить ссылку на документ.",
        "MODEL_UNAVAILABLE": "Модель временно недоступна.",
        "MODEL_TIMEOUT": "Превышено время ожидания модели.",
        "MODEL_RESPONSE_ERROR": "Модель вернула некорректный ответ.",
        "TEXT_EXTRACTION_FAILED": InsufficientResumeTextError.message,
        "INVALID_JOB": "Некорректное задание анализа.",
        "INTERNAL_ERROR": "Внутренняя ошибка обработки.",
    }

    return {
        **envelope(job),
        "status": "failed",
        "error": {
            "code": code,
            "message": messages[code],
        },
    }

MAX_RETRIES = 5


def should_retry(exc: Exception, retries: int) -> bool:
    _, retryable = classify_error(exc)
    return retryable and retries < MAX_RETRIES
