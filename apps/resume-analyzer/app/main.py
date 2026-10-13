import json
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.ollama_client import ModelUnavailable, MODEL_TIMEOUT
from app.rank_models import RequirementsRequest, RankResponse, ClusterResponse, ProfileResponse
from app.scoring import rank_profile
from app.readiness import is_ready, mark_ready, model_lock, monitor, PROBE_TIMEOUT
from app.text_extractor import extract_text_from_file

MAX_FILE_SIZE = 10 * 1024 * 1024
RANK_TIMEOUT = float(os.getenv("RANK_TIMEOUT_SECONDS", "840"))


@asynccontextmanager
async def lifespan(_app):
    stop = threading.Event()
    thread = threading.Thread(target=monitor, args=(stop,), daemon=True)
    thread.start()
    yield
    stop.set()


app = FastAPI(title="Resume Analyzer API", lifespan=lifespan)


@app.get("/")
@app.get("/health")
def health_check():
    return {"ok": True}


@app.get("/ready")
def readiness():
    available = is_ready()
    return JSONResponse(status_code=200 if available else 503,
                        content={"available": available})


@app.post("/rank", response_model=RankResponse)
def rank_resume(file: UploadFile = File(...), requirements: str = Form(...)):
    # Synchronous route runs in FastAPI's thread pool, never blocks /health.
    try:
        if len(requirements.encode("utf-8")) > 1024 * 1024:
            raise HTTPException(413, "Требования превышают 1 МБ.")
        requirements_obj = RequirementsRequest.model_validate(json.loads(requirements))
    except (ValueError, ValidationError):
        raise HTTPException(422, "Невалидные требования к профилям.")
    if not any(c.profiles for c in requirements_obj.clusters):
        raise HTTPException(422, "Нет профилей для анализа.")
    if not is_ready():
        raise HTTPException(503, "Модель недоступна. Повторите анализ позже.")
    file_bytes = file.file.read(MAX_FILE_SIZE + 1)
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(413, "Размер резюме превышает 10 МБ.")
    try:
        resume_text = extract_text_from_file(file_bytes, file.filename or "")
    except Exception:
        raise HTTPException(422, "Не удалось прочитать PDF или DOCX.")
    if len(resume_text.strip()) < 20:
        raise HTTPException(422, "Текст не извлечён. Для сканированного PDF необходим OCR.")
    if len(resume_text) > 50000:
        raise HTTPException(422, "Резюме слишком длинное: максимум 50 000 символов.")
    if not model_lock.acquire(timeout=PROBE_TIMEOUT + 5):
        raise HTTPException(503, "Модель занята. Повторите анализ позже.")
    deadline = time.monotonic() + RANK_TIMEOUT
    try:
        if not is_ready():
            raise ModelUnavailable("Модель недоступна. Повторите анализ позже.")
        clusters = []
        for cluster in requirements_obj.clusters:
            profiles = []
            for profile in cluster.profiles:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ModelUnavailable("Истекло время анализа. Повторите позже.")
                rating = rank_profile(resume_text, profile,
                                      f"{cluster.name}\nНаправление: {cluster.track or ''}\n{cluster.comment or ''}",
                                      timeout=min(MODEL_TIMEOUT, remaining))
                profiles.append(ProfileResponse(id=profile.id, position_name=profile.position_name, **rating))
            clusters.append(ClusterResponse(id=cluster.id, name=cluster.name, profiles=profiles))
        mark_ready(True)
        return RankResponse(clusters=clusters)
    except ModelUnavailable as exc:
        mark_ready(False)
        raise HTTPException(503, str(exc))
    finally:
        model_lock.release()
