"""Главный модуль FastAPI приложения."""

import json
import logging
import time
import uuid

from fastapi import FastAPI, UploadFile, File, Form, HTTPException

from app.config import settings
from app.logging_config import setup_logging, get_logger, get_diagnostic_logger, log_event
from app.ollama_client import ModelUnavailable
from app.rank_models import (
    RequirementsRequest,
    RankResponse,
    ClusterResponse,
    ProfileResponse,
)
from app.scoring import rank_profile
from app.text_extractor import extract_text_from_file

# Инициализация логирования при старте приложения
setup_logging()

logger = get_logger("app.main")
diag_logger = get_diagnostic_logger()

app = FastAPI(title="Resume Analyzer API")


@app.get("/")
async def health_check():
    """Проверка, что API работает."""
    return {"status": "ok", "message": "Resume Analyzer API is running"}


@app.get("/health")
async def health():
    """Healthcheck для Docker."""
    return {"status": "ok"}

@app.get("/ready")
async def ready():
    """Проверка готовности сервиса принимать задачи."""
    return {"status": "ready"}

@app.post("/rank", response_model=RankResponse)
async def rank_resume(
    file: UploadFile = File(...),
    requirements: str = Form(...),
):
    """
    Принимает файл резюме и требования, возвращает оценки по профилям.
    """
    job_id = str(uuid.uuid4())
    job_started_at = time.time()

    log_event(logger, logging.INFO, "rank_job_started",
              job_id=job_id,
              filename=file.filename,
              content_type=file.content_type)

    # ── Парсинг требований ──────────────────────────────────────────────
    try:
        requirements_data = json.loads(requirements)
        requirements_obj = RequirementsRequest(**requirements_data)
    except (json.JSONDecodeError, ValueError) as exc:
        log_event(logger, logging.WARNING, "rank_job_invalid_requirements",
                  job_id=job_id, error=str(exc))
        raise HTTPException(status_code=400, detail=f"Невалидные требования: {exc}")

    total_profiles = sum(len(c.profiles) for c in requirements_obj.clusters)

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
        file_bytes = await file.read()
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
        raise HTTPException(status_code=400, detail=str(exc))

    extract_duration = time.time() - extract_started_at

    log_event(logger, logging.INFO, "text_extraction_completed",
              job_id=job_id,
              duration_sec=round(extract_duration, 2),
              text_length_chars=len(resume_text))

    if not resume_text or len(resume_text.strip()) < 50:
        log_event(logger, logging.WARNING, "rank_job_insufficient_text",
                  job_id=job_id,
                  text_length_chars=len(resume_text))
        raise HTTPException(status_code=400, detail="Не удалось извлечь достаточно текста")

    # Диагностический лог: извлечённый текст резюме
    log_event(diag_logger, logging.DEBUG, "resume_text_extracted",
              job_id=job_id,
              text_length_chars=len(resume_text),
              text_preview=resume_text[:2000])

    # ── Оценка по профилям ──────────────────────────────────────────────
    result_clusters = []
    failed_profiles = 0

    for cluster in requirements_obj.clusters:
        cluster_profiles = []

        for profile in cluster.profiles:
            try:
                ranking_result = rank_profile(
                    resume_text,
                    profile,
                    cluster_requirements=cluster.comment or "",
                    job_id=job_id,
                )
            except ModelUnavailable as exc:
                failed_profiles += 1
                log_event(logger, logging.ERROR, "profile_ranking_failed",
                          job_id=job_id,
                          profile_id=profile.id,
                          position_name=profile.position_name,
                          error=str(exc))

                # Возвращаем профиль с нулевой оценкой и описанием ошибки
                ranking_result = {
                    "score": 0.0,
                    "matched_keywords": [],
                    "triggered_stop_factors": [],
                    "explanation": f"Ошибка оценки: {exc}",
                    "details": {"error": str(exc)},
                }

            profile_response = ProfileResponse(
                id=profile.id,
                position_name=profile.position_name,
                score=ranking_result.get("score", 0.0),
                matched_keywords=ranking_result.get("matched_keywords"),
                triggered_stop_factors=ranking_result.get("triggered_stop_factors"),
                details=ranking_result.get("details"),
                explanation=ranking_result.get("explanation"),
            )
            cluster_profiles.append(profile_response)

        result_clusters.append(ClusterResponse(
            id=cluster.id,
            name=cluster.name,
            profiles=cluster_profiles,
        ))

    # ── Завершение задания ──────────────────────────────────────────────
    total_duration = time.time() - job_started_at

    log_event(logger, logging.INFO, "rank_job_completed",
              job_id=job_id,
              total_duration_sec=round(total_duration, 2),
              profiles_total=total_profiles,
              profiles_failed=failed_profiles)

    return RankResponse(clusters=result_clusters)