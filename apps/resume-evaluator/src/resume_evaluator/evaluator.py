"""Evaluate one resume against the API's immutable target snapshot."""

import logging
import hashlib
import json
import time
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError
import pymupdf as fitz

from resume_documents.candidate_extractor import extract_contacts
from resume_documents.pdf_names import pdf_name_header
from resume_evaluator.config import settings
from resume_evaluator.evidence_scoring import validate_rating_source, POLICY_VERSION
from resume_evaluator.ollama_client import MODEL
from resume_evaluator.ollama_client import ModelResponseError, ModelTimeout, ModelUnavailable
from resume_evaluator.rank_models import ProfileRequest
from resume_evaluator.readiness import mark_ready, model_capacity
from resume_documents.resume_sections import resume_body
from resume_evaluator.scoring import ContextFitError, rank_profile, PROMPT_VERSION
from resume_documents.text_extractor import extract_text_from_file

from processing_runtime.protocol import DocumentError, InvalidJob, RetryJob, UUID


logger = logging.getLogger("processing.evaluator")
IMPLEMENTATION_REVISION = hashlib.sha256(b"\0".join(
    path.name.encode() + b"\0" + path.read_bytes()
    for path in sorted(Path(__file__).parent.glob("*.py")))).hexdigest()


def checkpoint_context(api, metadata, text, assessment_date):
    # Job scoped, never shared across people, modes, attempts, models or policies.
    value = {"version": 1, "job": api.job.command, "file": metadata["file"],
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "requirements": metadata["requirements"], "assessment_date": assessment_date,
        "model": MODEL, "policy": POLICY_VERSION, "prompt": PROMPT_VERSION,
        "implementation": IMPLEMENTATION_REVISION,
        "num_ctx": settings.OLLAMA_NUM_CTX, "max_tokens": settings.OLLAMA_MAX_TOKENS}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


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
        # Document extraction has no shared cache, including across vhosts.
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
    assessment_date = metadata.get("assessment_date") or datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    context = checkpoint_context(api, metadata, text, assessment_date)
    saved = metadata.get("evaluation_checkpoints", {})
    completed = {}
    if saved.get("context") == context:
        for evaluation in saved.get("evaluations", []):
            if evaluation.get("target_id") not in ids or evaluation["target_id"] in completed:
                raise InvalidJob()
            validate_rating_source(evaluation, text)
            completed[evaluation["target_id"]] = evaluation
    evaluations = []
    budget = min(api.job.deadline, time.time() + settings.RANK_TIMEOUT_SECONDS)
    try:
        with model_capacity(api.input) if len(completed) < len(targets) else nullcontext():
            for target in targets:
                api.input()
                if target.id in completed:
                    evaluations.append(completed[target.id])
                    continue
                profile = ProfileRequest(id=target.id, position_name=target.name,
                    education=target.education, experience=target.experience,
                    keywords=target.keywords, stop_factors=target.stop_factors, comment=target.comment)
                remaining = budget - time.time()
                if remaining <= 0:
                    raise RetryJob()
                rating = scorer(text, profile, target.cluster_comment,
                                timeout=remaining, job_id=api.job.id, assessment_date=assessment_date)
                validate_rating_source(rating, text)
                evaluation = {"target_id": target.id, **rating,
                    "criteria": [criterion_summary(rating.get("details", {}), name)
                                 for name in ("education", "experience", "keyword")]}
                evaluation = api.checkpoint(context, evaluation)
                validate_rating_source(evaluation, text)
                evaluations.append(evaluation)
    except (ModelUnavailable, ModelTimeout, ModelResponseError) as exc:
        if isinstance(exc, ModelUnavailable):
            mark_ready(False)
        logger.warning("Evaluation postponed (job_id=%s, reason=%s)", api.job.id, type(exc).__name__)
        raise RetryJob() from None
    except ContextFitError:
        raise DocumentError("LIMIT_EXCEEDED", "Требования не помещаются в контекст модели.") from None
    api.check()
    return {"status": "completed", **contacts, "evaluations": evaluations}
