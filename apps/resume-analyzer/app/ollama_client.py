import os
import time
from typing import Any, Optional

import requests

from app.config import settings
from app.logging_config import (
    get_logger, get_diagnostic_logger, log_event, EVENT_MESSAGES
)
import logging
import json

logger = get_logger("app.ollama")
diag_logger = get_diagnostic_logger()

OLLAMA_BASE_URL = settings.OLLAMA_BASE_URL.rstrip("/")
MODEL = settings.OLLAMA_MODEL
DEFAULT_TIMEOUT = settings.OLLAMA_TIMEOUT_SECONDS


class ModelUnavailable(Exception):
    """Модель недоступна или вернула некорректный ответ."""


def ask_ollama_chat(
    system_prompt: str,
    user_prompt: str,
    num_ctx: Optional[int] = None,
    max_tokens: Optional[int] = None,
    temperature: float = 0.0,
    timeout: Optional[float] = None,
    json_schema: Optional[dict] = None,
    *,
    job_id: str = "",
    profile_id: str = "",
    attempt: int = 1,
) -> dict:

    """Отправляет запрос в Ollama через chat API."""

    if num_ctx is None:
        num_ctx = settings.OLLAMA_NUM_CTX

    if max_tokens is None:
        max_tokens = settings.OLLAMA_MAX_TOKENS

    if timeout is None:
        timeout = settings.OLLAMA_TIMEOUT_SECONDS

    request_started_at = time.time()

    payload: dict[str, Any] = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "think": False,
        "keep_alive": settings.OLLAMA_KEEP_ALIVE,
        "options": {
            "num_ctx": num_ctx,
            "num_predict": max_tokens,
            "temperature": temperature,
        },
    }

    if json_schema is not None:
        payload["format"] = json_schema

    log_context = {
        "job_id": job_id,
        "profile_id": profile_id,
        "attempt": attempt,
        "model": MODEL,
    }

    # Запрос к модели
    log_event(logger, logging.INFO, "ollama_request_started",
              **log_context,
              num_ctx=num_ctx,
              max_tokens=max_tokens,
              temperature=temperature,
              timeout=timeout or DEFAULT_TIMEOUT,
              has_json_schema=json_schema is not None)

    # Диагностический лог: полный запрос
    log_event(diag_logger, logging.DEBUG, "ollama_request_full",
              **log_context,
              system_prompt=system_prompt,
              user_prompt=user_prompt,
              json_schema=json_schema,
              options=payload["options"])

    try:
        response = requests.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json=payload,
            timeout=timeout or DEFAULT_TIMEOUT,
        )
    except requests.exceptions.Timeout:
        duration = time.time() - request_started_at
        log_event(logger, logging.ERROR, "ollama_request_timeout",
                  **log_context, duration_sec=round(duration, 2))
        raise ModelUnavailable(f"Таймаут запроса к модели ({duration:.1f}s)")

    except requests.exceptions.RequestException as exc:
        duration = time.time() - request_started_at
        log_event(logger, logging.ERROR, "ollama_request_failed",
                  **log_context, duration_sec=round(duration, 2), error=str(exc))
        raise ModelUnavailable(f"Ошибка подключения к модели: {exc}")

    duration = time.time() - request_started_at
    http_status = response.status_code

    if http_status != 200:
        log_event(logger, logging.ERROR, "ollama_response_error",
                  **log_context,
                  http_status=http_status,
                  duration_sec=round(duration, 2),
                  response_preview=response.text[:500])
        raise ModelUnavailable(f"Модель вернула HTTP {http_status}")

    try:
        data = response.json()
        content = data["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Пустой ответ модели")
    except (ValueError, KeyError, TypeError) as exc:
        raise ModelUnavailable("Модель вернула некорректный или пустой ответ") from exc

    prompt_tokens = data.get("prompt_eval_count")
    generated_tokens = data.get("eval_count")
    prompt_eval_ns = data.get("prompt_eval_duration")
    eval_ns = data.get("eval_duration")

    # Ответ получен
    log_event(logger, logging.INFO, "ollama_response_received",
              **log_context,
              http_status=http_status,
              duration_sec=round(duration, 2),
              response_length_chars=len(content),
              prompt_tokens=prompt_tokens,
              generated_tokens=generated_tokens,
              prompt_eval_ms=round(prompt_eval_ns / 1_000_000, 1) if prompt_eval_ns else None,
              eval_ms=round(eval_ns / 1_000_000, 1) if eval_ns else None)

    # Диагностический лог: полный ответ
    log_event(diag_logger, logging.DEBUG, "ollama_response_full",
              **log_context,
              http_status=http_status,
              raw_response=content,
              raw_payload={k: v for k, v in data.items() if k != "message"})

    return {
        "response": content,
        "prompt_tokens": prompt_tokens,
        "generated_tokens": generated_tokens,
        "total_time_sec": round(duration, 2),
    }
