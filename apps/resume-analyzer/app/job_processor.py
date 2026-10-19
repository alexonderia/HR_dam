
"""Обработка одного задания анализа резюме."""

import logging

from app.analysis_service import analyze_resume_text
from app.candidate_extractor import extract_candidate
from app.document_loader import download_document
from app.rank_models import (
    ClusterRequest,
    ProfileRequest,
    RequirementsRequest,
)
from app.text_extractor import extract_text_from_file


logger = logging.getLogger(__name__)


class JobValidationError(ValueError):
    """Некорректное задание анализа."""


def build_requirements(job: dict) -> RequirementsRequest:
    """Преобразует snapshot требований в Pydantic-модели."""

    clusters = []

    for cluster_data in job["requirements"]:
        profiles = []

        for profile_data in cluster_data["profiles"]:
            profiles.append(
                ProfileRequest(
                    id=profile_data["id"],
                    position_name=profile_data["position_name"],
                    education=profile_data.get("education"),
                    experience=profile_data.get("experience"),
                    keywords=profile_data.get("keywords") or [],
                    stop_factors=profile_data.get("stop_factors") or [],
                    comment=profile_data.get("comment"),
                )
            )

        clusters.append(
            ClusterRequest(
                id=cluster_data["id"],
                name=cluster_data["name"],
                track=cluster_data.get("track"),
                comment=cluster_data.get("comment"),
                profiles=profiles,
            )
        )

    return RequirementsRequest(clusters=clusters)


def validate_analysis_structure(
    analysis: dict,
    requirements: RequirementsRequest,
) -> None:
    """Проверяет соответствие результата исходным требованиям."""

    expected_clusters = {
        cluster.id: cluster
        for cluster in requirements.clusters
    }

    actual_clusters = analysis.get("clusters", [])

    if len(actual_clusters) != len(expected_clusters):
        raise JobValidationError(
            "Количество кластеров в результате не совпадает."
        )

    seen_clusters = set()

    for cluster in actual_clusters:
        cluster_id = cluster["id"]

        if cluster_id in seen_clusters:
            raise JobValidationError(
                "В результате обнаружен дубликат кластера."
            )

        seen_clusters.add(cluster_id)

        expected_cluster = expected_clusters.get(cluster_id)

        if expected_cluster is None:
            raise JobValidationError(
                "Результат содержит неизвестный кластер."
            )

        expected_profiles = {
            profile.id: profile
            for profile in expected_cluster.profiles
        }

        actual_profiles = cluster["profiles"]

        if len(actual_profiles) != len(expected_profiles):
            raise JobValidationError(
                "Количество профилей в результате не совпадает."
            )

        seen_profiles = set()

        for profile in actual_profiles:
            profile_id = profile["id"]

            if profile_id in seen_profiles:
                raise JobValidationError(
                    "В результате обнаружен дубликат профиля."
                )

            seen_profiles.add(profile_id)

            if profile_id not in expected_profiles:
                raise JobValidationError(
                    "Результат содержит неизвестный профиль."
                )

            if not 0 <= profile["score"] <= 100:
                raise JobValidationError(
                    "Оценка профиля выходит за диапазон 0–100."
                )


def process_job(job: dict) -> dict:
    """Скачивает резюме, анализирует и формирует completed result."""

    job_id = job["job_id"]

    logger.info("Started resume analysis: job_id=%s", job_id)

    # 1. Преобразуем требования из RabbitMQ.
    requirements = build_requirements(job)

    # 2. Скачиваем документ и проверяем SHA-256.
    document_bytes = download_document(job)

    # 3. Извлекаем текст документа.
    resume_text = extract_text_from_file(
        document_bytes,
        job["file"]["file_name"],
    )

    # 4. Извлекаем ФИО и телефон.
    candidate = extract_candidate(resume_text)

    # 5. Выполняем существующий анализ через Ollama.
    analysis_result = analyze_resume_text(
        resume_text=resume_text,
        requirements=requirements,
        job_id=job_id,
    )

    analysis = analysis_result.model_dump()

    # 6. Проверяем полноту результата.
    validate_analysis_structure(
        analysis,
        requirements,
    )

    # 7. Формируем сообщение для hr.resume.results.
    result = {
        "version": job["version"],
        "job_id": job_id,
        "batch_id": job["batch_id"],
        "item_id": job["item_id"],
        "attempt": job["attempt"],
        "status": "completed",
        "candidate": candidate,
        "analysis": analysis,
    }

    logger.info(
        "Resume analysis completed: job_id=%s",
        job_id,
    )

    return result
