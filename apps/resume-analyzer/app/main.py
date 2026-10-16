"""Главный модуль FastAPI приложения."""

import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

from app.logging_config import setup_logging, get_logger, get_diagnostic_logger, log_event
from app.ollama_client import (
    ModelUnavailable,
    ModelTimeout,
    ModelResponseError,
    DEFAULT_TIMEOUT,
)
from app.rank_models import (
    RequirementsRequest,
    RankResponse,
    ClusterResponse,
    ProfileResponse,
)
from app.scoring import rank_profile, ContextFitError
from app.readiness import is_ready, mark_ready, model_lock, monitor, PROBE_TIMEOUT
from app.text_extractor import extract_text_from_file

# Инициализация логирования при старте приложения
setup_logging()

logger = get_logger("app.main")
diag_logger = get_diagnostic_logger()

RANK_TIMEOUT = float(os.getenv("RANK_TIMEOUT_SECONDS", "840"))


@asynccontextmanager
async def lifespan(_app):
    stop = threading.Event()
    mark_ready(False)
    thread = threading.Thread(target=monitor, args=(stop,), daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()


app = FastAPI(title="Resume Analyzer API", lifespan=lifespan)


@app.get("/")
@app.get("/health")
def health_check():
    """Проверка, что API работает."""
    return {"ok": True}

@app.get("/ready")
def readiness():
    """Проверка готовности сервиса принимать задачи."""
    available = is_ready()
    return JSONResponse(status_code=200 if available else 503,
                        content={"available": available})

@app.post("/rank", response_model=RankResponse)
def rank_resume(
    file: UploadFile = File(...),
    requirements: str = Form(...),
):
    """
    Принимает файл резюме и требования, возвращает оценки по профилям.
    """
    # Blocking extraction/model calls run in FastAPI's thread pool so status stays responsive.
    job_id = str(uuid.uuid4())
    job_started_at = time.time()

    log_event(logger, logging.INFO, "rank_job_started",
              job_id=job_id,
              filename=file.filename,
              content_type=file.content_type)

    # ── Парсинг требований ──────────────────────────────────────────────
    try:
        requirements_data = json.loads(requirements)
        requirements_obj = RequirementsRequest.model_validate(requirements_data)
    except (ValueError, TypeError) as exc:
        log_event(logger, logging.WARNING, "rank_job_invalid_requirements",
                  job_id=job_id, error=str(exc))
        raise HTTPException(status_code=422, detail=f"Невалидные требования: {exc}")

    total_profiles = sum(len(c.profiles) for c in requirements_obj.clusters)
    if not total_profiles:
        raise HTTPException(status_code=422, detail="Нет профилей для анализа.")
    if not is_ready():
        raise HTTPException(status_code=503, detail="Модель недоступна. Повторите анализ позже.")

    log_event(logger, logging.INFO, "requirements_parsed",
              job_id=job_id,
              clusters_count=len(requirements_obj.clusters),
              profiles_count=total_profiles)

    # Диагностический лог: полный набор требований
    log_event(diag_logger, logging.DEBUG, "requirements_full",
              job_id=job_id,
              requirements=requirements_data)

    # ── Чтение файла ────────────────────────────────────────────────────
    try:
        file_bytes = file.file.read()
    except Exception as exc:
        log_event(logger, logging.ERROR, "rank_job_file_read_failed",
                  job_id=job_id, error=str(exc))
        raise HTTPException(status_code=500, detail="Ошибка чтения файла")

    log_event(logger, logging.INFO, "file_received",
              job_id=job_id,
              filename=file.filename,
              size_bytes=len(file_bytes))

    # ── Извлечение текста ───────────────────────────────────────────────
    extract_started_at = time.time()

    log_event(logger, logging.INFO, "text_extraction_started", job_id=job_id)

    try:
        resume_text = extract_text_from_file(file_bytes, file.filename or "resume")
    except Exception as exc:
        log_event(logger, logging.ERROR, "text_extraction_failed",
                  job_id=job_id, error=str(exc))
        raise HTTPException(status_code=422, detail=str(exc))

    extract_duration = time.time() - extract_started_at

    log_event(logger, logging.INFO, "text_extraction_completed",
              job_id=job_id,
              duration_sec=round(extract_duration, 2),
              text_length_chars=len(resume_text))

    if not resume_text or len(resume_text.strip()) < 50:
        log_event(logger, logging.WARNING, "rank_job_insufficient_text",
                  job_id=job_id,
                  text_length_chars=len(resume_text))
        raise HTTPException(status_code=422, detail="Не удалось извлечь достаточно текста")

    # Диагностический лог: извлечённый текст резюме
    log_event(diag_logger, logging.DEBUG, "resume_text_extracted",
              job_id=job_id,
              text_length_chars=len(resume_text),
              text_preview=resume_text[:2000])

    # ── Оценка по профилям ──────────────────────────────────────────────
    result_clusters = []
    if not model_lock.acquire(timeout=PROBE_TIMEOUT + 5):
        raise HTTPException(status_code=503, detail="Модель занята. Повторите анализ позже.")
    deadline = time.monotonic() + RANK_TIMEOUT
    try:
        if not is_ready():
            raise ModelUnavailable("Модель недоступна. Повторите анализ позже.")
        for cluster in requirements_obj.clusters:
            cluster_profiles = []

            for profile in cluster.profiles:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ModelTimeout(
                        "Истекло общее время обработки резюме"
                    )
                ranking_result = rank_profile(
                    resume_text,
                    profile,
                    cluster_requirements=cluster.comment or "",
                    timeout=min(DEFAULT_TIMEOUT, remaining),
                    job_id=job_id,
                )
                cluster_profiles.append(ProfileResponse(
                    id=profile.id,
                    position_name=profile.position_name,
                    **ranking_result,
                ))

            result_clusters.append(ClusterResponse(
                id=cluster.id,
                name=cluster.name,
                profiles=cluster_profiles,
            ))
        # Проверяем общий таймаут даже после последнего профиля.
        if time.monotonic() >= deadline:
            raise ModelTimeout(
                "Истекло общее время обработки резюме"
            )
        mark_ready(True)

    except ModelUnavailable as exc:
        mark_ready(False)
        log_event(
            logger,
            logging.ERROR,
            "profile_ranking_failed",
            job_id=job_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail="Сервис модели временно недоступен",
        ) from exc

    except ModelTimeout as exc:
        log_event(
            logger,
            logging.ERROR,
            "profile_ranking_timeout",
            job_id=job_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise HTTPException(
            status_code=504,
            detail="Превышено время ожидания ответа модели",
        ) from exc

    except ModelResponseError as exc:
        log_event(
            logger,
            logging.ERROR,
            "profile_ranking_invalid_response",
            job_id=job_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise HTTPException(
            status_code=502,
            detail="Модель вернула некорректный ответ",
        ) from exc

    except ContextFitError as exc:
        log_event(
            logger,
            logging.WARNING,
            "profile_ranking_context_error",
            job_id=job_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc
    finally:
        model_lock.release()

    # ── Завершение задания ──────────────────────────────────────────────
    total_duration = time.time() - job_started_at

    log_event(logger, logging.INFO, "rank_job_completed",
              job_id=job_id,
              total_duration_sec=round(total_duration, 2),
              profiles_total=total_profiles,
              profiles_failed=0)

    return RankResponse(clusters=result_clusters)
