"""Shared HTTP/AMQP entry point: assess requirements jointly, then score locally."""

import hashlib
import json
import logging
import time

from app.batch_scoring import STRATEGY_VERSION, rank_requirements
from app.config import settings
from app.errors import InsufficientResumeTextError
from app.evidence_scoring import POLICY_VERSION, validate_rating_source
from app.logging_config import get_logger, log_event
from app.ollama_client import MODEL, ModelResponseError, ModelUnavailable
from app.rank_models import RankResponse, RequirementsRequest
from app.readiness import check_model_cancelled, is_ready, mark_ready, model_capacity


RANK_TIMEOUT = settings.RANK_TIMEOUT_SECONDS
logger = get_logger("app.analysis_service")


def checkpoint_key(resume_text: str, requirements: RequirementsRequest) -> str:
    payload = json.dumps([resume_text, requirements.model_dump(), MODEL, POLICY_VERSION, STRATEGY_VERSION],
                         ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def analyze_resume_text(resume_text: str, requirements: RequirementsRequest, job_id: str) -> RankResponse:
    if not resume_text or len(resume_text.strip()) < 50:
        raise InsufficientResumeTextError()
    with model_capacity():
        started = time.monotonic()
        profile_count = sum(len(cluster.profiles) for cluster in requirements.clusters)
        log_event(logger, logging.INFO, "analysis_started", job_id=job_id,
                  profiles=profile_count, strategy=STRATEGY_VERSION)
        try:
            if not is_ready():
                raise ModelUnavailable("Модель недоступна")
            result = rank_requirements(resume_text, requirements, timeout=RANK_TIMEOUT,
                                       job_id=job_id, checkpoint_key=checkpoint_key(resume_text, requirements))
            check_model_cancelled()
            try:
                for cluster in result.clusters:
                    for profile in cluster.profiles:
                        validate_rating_source(profile.model_dump(), resume_text)
            except ValueError as exc:
                raise ModelResponseError("Подтверждения оценки не совпадают с резюме") from exc
            mark_ready(True)
            log_event(logger, logging.INFO, "analysis_completed", job_id=job_id, profiles=profile_count,
                      strategy=STRATEGY_VERSION, restored_duration_ms=result._restored_duration_ms,
                      duration_sec=round(time.monotonic() - started, 2))
            return result
        except ModelUnavailable:
            mark_ready(False)
            raise
        except Exception:
            log_event(logger, logging.INFO, "analysis_interrupted", job_id=job_id,
                      profiles=profile_count, strategy=STRATEGY_VERSION)
            raise
