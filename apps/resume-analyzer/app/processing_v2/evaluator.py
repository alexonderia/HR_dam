"""Evaluate one resume against the API's immutable target snapshot."""

import logging
import time
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError
import pymupdf as fitz

from app.candidate_extractor import extract_contacts
from app.pdf_names import pdf_name_header
from app.config import settings
from app.evidence_scoring import validate_rating_source
from app.ollama_client import ModelResponseError, ModelTimeout, ModelUnavailable
from app.rank_models import ProfileRequest
from app.readiness import model_capacity
from app.resume_sections import resume_body
from app.scoring import ContextFitError, rank_profile
from app.text_extractor import extract_text_from_file

from .protocol import DocumentError, InvalidJob, RetryJob, UUID


logger = logging.getLogger("processing.evaluator")


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    name: str = Field(min_length=1, max_length=300)
    education: str = Field(max_length=10000)
    experience: str = Field(max_length=10000)
    keywords: list[str] = Field(max_length=100)
    stop_factors: list[str] = Field(max_length=100)
    comment: str = Field(max_length=10000)
    cluster_comment: str = Field(default="", max_length=10000)


def criterion_summary(details, category):
    entries = [c for c in details.get("criteria", []) if c["category"] == category]
    statuses = {c["status"] for c in entries}
    if not statuses or statuses == {"unknown"}:
        status = "unknown"
    elif statuses == {"met"}:
        status = "matched"
    elif statuses == {"not_met"}:
        status = "not_matched"
    else:
        status = "partial"
    explanation = "; ".join(c["requirement"] + ": " + c["status"] for c in entries)
    return {"name": "keywords" if category == "keyword" else category, "status": status,
            "explanation": explanation[:10000] or "Требование не задано; соответствие не определено."}


def evaluate(api, metadata, source, directory, scorer=rank_profile):
    filename = metadata["file"]["file_name"]
    if Path(filename).suffix.lower() not in {".pdf", ".docx", ".doc", ".rtf", ".txt"}:
        raise DocumentError("UNSUPPORTED_FORMAT", "Формат резюме не поддерживается.")
    try:
        targets = [Target.model_validate(t) for t in metadata["requirements"]["targets"]]
        ids = [t.id for t in targets]
        if not 1 <= len(targets) <= 200 or len(set(ids)) != len(ids) or any(not UUID.fullmatch(i) for i in ids):
            raise InvalidJob()
    except (KeyError, TypeError, ValidationError):
        raise InvalidJob() from None
    api.check()
    try:
        # V2 disables the legacy text cache at process startup; no document is
        # retained for another job, including a job from the other vhost.
        data = source.read_bytes()
        text = extract_text_from_file(data, filename)
        name_header = None
        if Path(filename).suffix.lower() == ".pdf":
            text = resume_body(text)
            with fitz.open(stream=data, filetype="pdf") as document:
                name_header = pdf_name_header(document[0], resume_body(document[0].get_text()))
    except Exception:
        raise DocumentError("TEXT_EXTRACTION_FAILED", "Не удалось прочитать текст резюме.") from None
    if len(text.strip()) < 50:
        raise DocumentError("TEXT_EXTRACTION_FAILED", "В резюме недостаточно доступного текста; для скана требуется OCR.")
    contacts = extract_contacts(text, name_header=name_header)
    evaluations = []
    budget = min(api.job.deadline, time.time() + settings.RANK_TIMEOUT_SECONDS)
    try:
        with model_capacity(api.check):
            for target in targets:
                api.input()
                profile = ProfileRequest(id=target.id, position_name=target.name,
                    education=target.education, experience=target.experience,
                    keywords=target.keywords, stop_factors=target.stop_factors, comment=target.comment)
                remaining = budget - time.time()
                if remaining <= 0:
                    raise RetryJob()
                rating = scorer(text, profile, target.cluster_comment,
                                timeout=remaining, job_id=api.job.id)
                validate_rating_source(rating, text)
                evaluation = {"target_id": target.id, **rating,
                    "criteria": [criterion_summary(rating.get("details", {}), name)
                                 for name in ("education", "experience", "keyword")]}
                evaluations.append(evaluation)
    except (ModelUnavailable, ModelTimeout, ModelResponseError) as exc:
        logger.warning("Evaluation postponed (job_id=%s, reason=%s)", api.job.id, type(exc).__name__)
        raise RetryJob() from None
    except ContextFitError:
        raise DocumentError("LIMIT_EXCEEDED", "Требования не помещаются в контекст модели.") from None
    api.check()
    return {"status": "completed", **contacts, "evaluations": evaluations}
