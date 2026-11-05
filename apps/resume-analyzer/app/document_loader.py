
"""Загрузка документов из S3 по подписанным ссылкам."""

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

from app.config import settings


logger = logging.getLogger(__name__)

MAX_DOCUMENT_SIZE = 50 * 1024 * 1024
DOWNLOAD_TIMEOUT = (10, 120)
REFRESH_TIMEOUT = (10, 20)

class DocumentDownloadError(Exception):
    """Ошибка скачивания документа."""

class DownloadLinkError(Exception):
    """Не удалось обновить ссылку на документ.""" 

class DownloadLinkTemporaryError(DownloadLinkError):
    """Backend временно недоступен при обновлении ссылки."""

class DocumentTemporaryError(DocumentDownloadError):
    """Временная ошибка скачивания документа из S3."""    

class DocumentIntegrityError(Exception):
    """Размер или SHA-256 документа не совпадает."""


def parse_expiration(value: str) -> datetime:
    """Преобразует ISO 8601 в datetime с часовым поясом."""

    return datetime.fromisoformat(
        value.replace("Z", "+00:00")
    ).astimezone(timezone.utc)


def refresh_download_url(job: dict) -> tuple[str, str]:
    """Запрашивает новую подписанную ссылку у backend."""

    if not settings.RESUME_ANALYZER_CALLBACK_TOKEN:
        raise DownloadLinkError(
            "Не настроен токен обновления ссылки."
        )

    batch_id = quote(job["batch_id"], safe="")
    item_id = quote(job["item_id"], safe="")

    url = (
        f"{settings.BACKEND_BASE_URL.rstrip('/')}"
        f"/api/internal/resume-imports/"
        f"{batch_id}/items/{item_id}/download-url"
    )

    try:
        response = requests.post(
            url,
            headers={
                "Authorization": (
                    f"Bearer {settings.RESUME_ANALYZER_CALLBACK_TOKEN}"
                )
            },
            timeout=REFRESH_TIMEOUT,
        )

    except requests.RequestException as exc:
        raise DownloadLinkTemporaryError(
            "Backend недоступен при обновлении ссылки."
        ) from exc

    if response.status_code in (408, 429) or response.status_code >= 500:
        raise DownloadLinkTemporaryError(
            f"Временная ошибка Backend: HTTP {response.status_code}"
        )

    if response.status_code != 200:
        raise DownloadLinkError(
            f"Backend отклонил обновление ссылки: HTTP {response.status_code}"
        )

    try:
        data = response.json()

        download_url = data["download_url"]
        expires_at = data["download_url_expires_at"]

        if not isinstance(download_url, str) or not download_url:
            raise ValueError("Invalid download_url")

        if not isinstance(expires_at, str) or not expires_at:
            raise ValueError("Invalid expiration")

        parse_expiration(expires_at)

        return download_url, expires_at

    except (ValueError, KeyError, TypeError) as exc:
        raise DownloadLinkError(
            "Backend вернул некорректные данные ссылки."
        ) from exc


def download_document(job: dict) -> bytes:
    """Скачивает документ и проверяет его целостность."""

    file = job["file"]

    expected_size = int(file["size_bytes"])
    expected_sha256 = file["sha256"].lower()

    if not 0 < expected_size <= MAX_DOCUMENT_SIZE:
        raise DocumentIntegrityError(
            "Недопустимый размер документа."
        )

    download_url = file["download_url"]
    expires_at = file["download_url_expires_at"]

    try:
        expiration = parse_expiration(expires_at)
    except (ValueError, TypeError) as exc:
        raise DownloadLinkError(
            "Некорректный срок действия ссылки."
        ) from exc

    # Обновляем ссылку заранее, чтобы она не истекла
    # непосредственно перед началом скачивания.
    if expiration <= datetime.now(timezone.utc) + timedelta(seconds=60):
        download_url, expires_at = refresh_download_url(job)
        logger.info("Refreshed download URL for job %s", job["job_id"])

    try:
        with requests.get(
            download_url,
            stream=True,
            timeout=DOWNLOAD_TIMEOUT,
        ) as response:
            response.raise_for_status()

            content = bytearray()
            digest = hashlib.sha256()

            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue

                content.extend(chunk)
                digest.update(chunk)

                if len(content) > expected_size:
                    raise DocumentIntegrityError(
                        "Размер документа превышает ожидаемый."
                    )

    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else None

        if status_code in (408, 429) or (
            status_code is not None and status_code >= 500
        ):
            raise DocumentTemporaryError(
                f"Временная ошибка S3: HTTP {status_code}"
            ) from exc

        raise DocumentDownloadError(
            f"Ошибка скачивания документа: HTTP {status_code}"
        ) from exc

    except requests.RequestException as exc:
        raise DocumentTemporaryError(
            "Временная ошибка подключения к S3."
        ) from exc

    if len(content) != expected_size:
        raise DocumentIntegrityError(
            "Размер скачанного документа не совпадает."
        )

    if digest.hexdigest() != expected_sha256:
        raise DocumentIntegrityError(
            "Контрольная сумма SHA-256 не совпадает."
        )

    logger.info(
        "Document downloaded and verified: job=%s size=%s",
        job["job_id"],
        len(content),
    )

    return bytes(content)
