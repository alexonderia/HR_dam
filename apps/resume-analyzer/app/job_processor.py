"""AMQP document download and envelope around the shared analysis pipeline."""

import logging
import threading

from app.analysis_service import analyze_resume_text
from app.document_loader import download_document
from app.errors import JobCancelled, JobValidationError
from app.pipeline import process_document
from app.requirements import build_requirements, validate_analysis_structure

logger = logging.getLogger(__name__)


def process_job(job: dict, stop_event: threading.Event | None = None) -> dict:
    def check_cancelled():
        if stop_event is not None and stop_event.is_set():
            raise JobCancelled("Resume analysis cancelled")

    check_cancelled()
    requirements = build_requirements(job)
    content = download_document(job)
    result = process_document(content, job["file"]["file_name"], requirements, job["job_id"],
                              check_cancelled=check_cancelled, analyze=analyze_resume_text).model_dump()
    analysis = {"clusters": result.pop("clusters")}
    return {"version": job["version"], "job_id": job["job_id"], "batch_id": job["batch_id"],
            "item_id": job["item_id"], "attempt": job["attempt"], "status": "completed", **result, "analysis": analysis}
