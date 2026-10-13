from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from pydantic import BaseModel
from typing import Optional
import json

from app.text_extractor import extract_text_from_file
from app.rank_models import (
    RequirementsRequest,
    RankResponse,
    ClusterResponse,
    ProfileResponse
)
from app.ranker import rank_profile


app = FastAPI(title="Resume Analyzer API")


# Старые модели (оставляем для совместимости)
class ResumeRequest(BaseModel):
    resume_id: str
    department: str
    resume_text: str


class ResumeResponse(BaseModel):
    resume_id: str
    department: str
    overall_score: int
    recommendation: str
    summary: str


@app.get("/")
async def health_check():
    """Проверка, что API работает"""
    return {"status": "ok", "message": "Resume Analyzer API is running"}


@app.post("/rank", response_model=RankResponse)
async def rank_resume(
    file: UploadFile = File(...),
    requirements: str = Form(...)
):
    """
    Принимает файл резюме и требования, возвращает оценки по профилям.
    """
    
    # Парсим JSON с требованиями
    try:
        requirements_data = json.loads(requirements)
        requirements_obj = RequirementsRequest(**requirements_data)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Невалидный JSON в поле requirements: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Ошибка при парсинге требований: {str(e)}"
        )
    
    # Читаем файл
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Ошибка при чтении файла: {str(e)}"
        )
    
    # Извлекаем текст
    try:
        resume_text = extract_text_from_file(file_bytes, file.filename)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=str(e)
        )
    
    if not resume_text or len(resume_text.strip()) < 50:
        raise HTTPException(
            status_code=400,
            detail="Не удалось извлечь достаточно текста из файла"
        )
    
    # Оцениваем по каждому кластеру и профилю
    result_clusters = []
    
    for cluster in requirements_obj.clusters:
        cluster_profiles = []
        
        for profile in cluster.profiles:
            # Оцениваем профиль
            ranking_result = rank_profile(resume_text, profile)
            
            # Формируем ответ по профилю
            profile_response = ProfileResponse(
                id=profile.id,
                position_name=profile.position_name,
                score=ranking_result.get("score", 0.0),
                matched_keywords=ranking_result.get("matched_keywords"),
                triggered_stop_factors=ranking_result.get("triggered_stop_factors"),
                details=ranking_result.get("details"),
                explanation=ranking_result.get("explanation")
            )
            
            cluster_profiles.append(profile_response)
        
        # Формируем ответ по кластеру
        cluster_response = ClusterResponse(
            id=cluster.id,
            name=cluster.name,
            profiles=cluster_profiles
        )
        
        result_clusters.append(cluster_response)
    
    return RankResponse(clusters=result_clusters)