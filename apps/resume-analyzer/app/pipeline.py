"""One document, contact, validation and timing pipeline for HTTP and AMQP."""

from time import monotonic
from collections.abc import Callable

from app.analysis_service import analyze_resume_text
from app.errors import InsufficientResumeTextError, JobValidationError
from app.rank_models import RequirementsRequest, RankWithContactsResponse
from app.readiness import model_capacity
from app.requirements import validate_analysis_structure
from app.resume_document import prepare_resume_document


def process_document(content: bytes, filename: str, requirements: RequirementsRequest, job_id: str,
                     check_cancelled: Callable[[], None] = lambda: None,
                     analyze: Callable = analyze_resume_text) -> RankWithContactsResponse:
    if not sum(len(cluster.profiles) for cluster in requirements.clusters):
        raise JobValidationError("Нет профилей для анализа.")
    check_cancelled()
    extraction_started = monotonic()
    text, contacts = prepare_resume_document(content, filename)
    extraction_duration = monotonic() - extraction_started
    if len(text.strip()) < 50:
        raise InsufficientResumeTextError()
    check_cancelled()
    # Waiting for readiness/capacity and document download do not count as analysis.
    with model_capacity(check_cancelled=check_cancelled):
        check_cancelled()
        started = monotonic()
        result = analyze(resume_text=text, requirements=requirements, job_id=job_id)
        check_cancelled()
        analysis = result.model_dump()
        validate_analysis_structure(analysis, requirements)
        duration = min(2147483647, max(0, round((extraction_duration + monotonic() - started) * 1000)))
    return RankWithContactsResponse.model_validate({**analysis, **contacts, "analysis_duration_ms": duration})
