import requests

from app.config import settings


class JobStatusTemporaryError(Exception):
    """Backend временно недоступен."""


class JobStatusPermanentError(Exception):
    """Ошибка конфигурации или контракта задания."""


def check_job_status(job: dict) -> bool:

    url = (
        f"{settings.BACKEND_BASE_URL.rstrip('/')}"
        "/api/internal/resume-jobs/status"
    )

    payload = {
        "version": job["version"],
        "job_id": job["job_id"],
        "batch_id": job["batch_id"],
        "item_id": job["item_id"],
        "attempt": job["attempt"],
    }

    if not settings.RESUME_ANALYZER_CALLBACK_TOKEN:
        raise JobStatusPermanentError(
            "RESUME_ANALYZER_CALLBACK_TOKEN is not configured"
    )

    headers = {
        "Authorization": (
            f"Bearer {settings.RESUME_ANALYZER_CALLBACK_TOKEN}"
        )
    }

    try:
        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=settings.BACKEND_STATUS_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise JobStatusTemporaryError(
            "Backend is unavailable"
        ) from exc

    if response.status_code in (401, 404, 422):
        raise JobStatusPermanentError(
            f"Backend rejected job: HTTP {response.status_code}"
        )

    if response.status_code >= 500 or response.status_code in (408, 429):
        raise JobStatusTemporaryError(
            f"Backend temporary error: HTTP {response.status_code}"
        )

    if response.status_code != 200:
        raise JobStatusPermanentError(
            f"Unexpected HTTP status: {response.status_code}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise JobStatusTemporaryError(
            "Backend returned invalid JSON"
        ) from exc

    if not isinstance(data, dict):
        raise JobStatusTemporaryError(
            "Invalid backend response"
        )

    if data.get("status") not in {
        "pending", "processing", "completed", "failed", "superseded"
    }:
        raise JobStatusTemporaryError(
            "Unknown backend job status"
        )

    should_process = data.get("should_process")

    if type(should_process) is not bool:
        raise JobStatusTemporaryError(
            "Missing or invalid should_process"
        )

    if (data["status"] in ("pending", "processing")) != should_process:
        raise JobStatusTemporaryError(
            "Inconsistent backend job status"
        )

    return should_process