
"""Формирование сообщений RabbitMQ по контракту."""

from datetime import datetime
from app.logging_config import MOSCOW_TIME_ZONE

from app.analysis_service import InsufficientResumeTextError
from app.document_loader import (
    DocumentDownloadError,
    DocumentIntegrityError,
    DownloadLinkError,
)
from app.errors import JobValidationError, DocumentTextError
from app.document_loader import DocumentTemporaryError, DownloadLinkTemporaryError
from app.job_status import JobStatusTemporaryError, JobStatusPermanentError
from app.scoring import ContextFitError
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
        "created_at": datetime.now(MOSCOW_TIME_ZONE).isoformat(timespec="milliseconds"),
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

    if isinstance(exc, (InsufficientResumeTextError, DocumentTextError)):
        return "TEXT_EXTRACTION_FAILED", False

    if isinstance(exc, ContextFitError):
        return "CONTEXT_LIMIT", False

    if isinstance(exc, JobStatusPermanentError):
        return "INVALID_JOB", False

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
        "CONTEXT_LIMIT": "Документ или требования превышают допустимый контекст модели.",
        "INTERNAL_ERROR": "Внутренняя ошибка обработки.",
    }

    return {
        **envelope(job),
        "status": "failed",
        "error": {
            "code": code,
            "message": "Не удалось прочитать текст документа." if isinstance(exc, DocumentTextError) else messages[code],
        },
    }

MAX_RETRIES = 5


def should_retry(exc: Exception, retries: int) -> bool:
    _, retryable = classify_error(exc)
    return retryable and retries < MAX_RETRIES


def infrastructure_error(exc: Exception) -> bool:
    return isinstance(exc, (ModelUnavailable, ModelTimeout, JobStatusTemporaryError,
                            DocumentTemporaryError, DownloadLinkTemporaryError))


def http_error(exc: Exception) -> tuple[int, str]:
    code, _ = classify_error(exc)
    status = {"MODEL_UNAVAILABLE": 503, "MODEL_TIMEOUT": 504, "MODEL_RESPONSE_ERROR": 502,
              "TEXT_EXTRACTION_FAILED": 422, "INVALID_JOB": 422, "CONTEXT_LIMIT": 422}.get(code, 500)
    # The transport exposes the same safe messages as the AMQP error result.
    placeholder = dict(version=1, job_id="", batch_id="", item_id="", attempt=1)
    return status, failed_result(placeholder, exc)["error"]["message"]
