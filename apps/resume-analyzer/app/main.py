"""One analyzer process with HTTP control endpoints and one selected adapter."""

import asyncio
import json
import logging
import threading
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

from app.analysis_service import analyze_resume_text
from app.config import settings
from app.errors import JobValidationError
from app.job_result import http_error
from app.logging_config import setup_logging, get_logger
from app.pipeline import process_document
from app.rank_models import RequirementsRequest, ContactsResponse, RankWithContactsResponse
from app.readiness import is_ready, mark_ready, monitor
from app.resume_document import prepare_resume_document
from app.runtime import runtime_status, update_runtime

setup_logging()
logger = get_logger("app.main")


@asynccontextmanager
async def lifespan(_app):
    settings.validate()
    stop = threading.Event()
    mark_ready(False)
    update_runtime(stopping=False, broker_connected=False, consumer_alive=False, busy=False)
    threads = [threading.Thread(target=monitor, args=(stop,), daemon=True, name="model-readiness")]
    if settings.ANALYZER_ADAPTER == "amqp":
        from app.consumer import run_consumer
        threads.append(threading.Thread(target=run_consumer, args=(stop,), daemon=True, name="amqp-consumer"))
    for thread in threads:
        thread.start()
    try:
        yield
    finally:
        update_runtime(stopping=True)
        stop.set()
        for thread in reversed(threads):
            await asyncio.to_thread(thread.join, settings.SHUTDOWN_GRACE_SECONDS)
            if thread.is_alive():
                logger.error("Service thread did not stop within shutdown grace: %s", thread.name)
        mark_ready(False)
        update_runtime(broker_connected=False, consumer_alive=False, busy=False, stopping=False)


app = FastAPI(title="Resume Analyzer API", lifespan=lifespan)


@app.get("/")
@app.get("/health")
def health_check():
    state = runtime_status(is_ready())
    if not state["alive"]:
        return JSONResponse(status_code=503, content={"ok": False, **state})
    return {"ok": True}


@app.get("/status")
def status():
    return runtime_status(is_ready())


@app.get("/ready")
def readiness():
    state = status()
    return JSONResponse(status_code=200 if state["available"] else 503, content=state)


@app.post("/contacts", response_model=ContactsResponse)
def resume_contacts(file: UploadFile = File(...)):
    try:
        _, contacts = prepare_resume_document(file.file.read(), file.filename or "resume")
        return ContactsResponse.model_validate(contacts)
    except Exception as exc:
        status_code, message = http_error(exc)
        raise HTTPException(status_code=status_code, detail=message) from exc


@app.post("/rank", response_model=RankWithContactsResponse)
def rank_resume(file: UploadFile = File(...), requirements: str = Form(...)):
    if settings.ANALYZER_ADAPTER != "http":
        raise HTTPException(status_code=409, detail="HTTP scoring adapter is disabled; ANALYZER_ADAPTER=amqp")
    try:
        try:
            parsed = RequirementsRequest.model_validate(json.loads(requirements))
        except (ValueError, TypeError) as exc:
            raise JobValidationError("Invalid requirements") from exc
        return process_document(file.file.read(), file.filename or "resume", parsed, str(uuid.uuid4()), analyze=analyze_resume_text)
    except Exception as exc:
        status_code, message = http_error(exc)
        logger.log(logging.WARNING if status_code < 500 else logging.ERROR,
                   "HTTP analysis stopped: %s", type(exc).__name__)
        raise HTTPException(status_code=status_code, detail=message) from exc
