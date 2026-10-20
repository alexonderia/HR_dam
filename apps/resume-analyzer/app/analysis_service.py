
import os
import time

from app.ollama_client import (
    DEFAULT_TIMEOUT,
    ModelUnavailable,
    ModelTimeout,
    ModelResponseError,
)
from app.rank_models import (
    RequirementsRequest,
    RankResponse,
    ClusterResponse,
    ProfileResponse,
)
from app.readiness import (
    is_ready,
    mark_ready,
    model_lock,
    PROBE_TIMEOUT,
)
from app.scoring import rank_profile
from app.evidence_scoring import validate_rating_source


RANK_TIMEOUT = float(os.getenv("RANK_TIMEOUT_SECONDS", "840"))


class InsufficientResumeTextError(ValueError):
    """В документе недостаточно доступного текста для анализа."""

    message = (
        "Не удалось извлечь достаточно текста из резюме. "
        "Загрузите документ с доступным текстом."
    )

    def __init__(self):
        super().__init__(self.message)


def analyze_resume_text(
    resume_text: str,
    requirements: RequirementsRequest,
    job_id: str,
) -> RankResponse:
    """Оценивает резюме по всем кластерам и профилям."""

    if not resume_text or len(resume_text.strip()) < 50:
        raise InsufficientResumeTextError()

    if not is_ready():
        raise ModelUnavailable("Модель недоступна")

    if not model_lock.acquire(timeout=PROBE_TIMEOUT + 5):
        raise ModelUnavailable("Модель занята")

    result_clusters = []
    deadline = time.monotonic() + RANK_TIMEOUT

    try:
        if not is_ready():
            raise ModelUnavailable("Модель недоступна")

        for cluster in requirements.clusters:
            cluster_profiles = []

            for profile in cluster.profiles:
                remaining = deadline - time.monotonic()

                if remaining <= 0:
                    raise ModelTimeout(
                        "Истекло общее время обработки резюме"
                    )

                ranking_result = rank_profile(
                    resume_text,
                    profile,
                    cluster_requirements=cluster.comment or "",
                    timeout=min(DEFAULT_TIMEOUT, remaining),
                    job_id=job_id,
                )
                try:
                    validate_rating_source(ranking_result, resume_text)
                except ValueError as error:
                    raise ModelResponseError("Подтверждения оценки не совпадают с резюме") from error

                cluster_profiles.append(
                    ProfileResponse(
                        id=profile.id,
                        position_name=profile.position_name,
                        **ranking_result,
                    )
                )

            result_clusters.append(
                ClusterResponse(
                    id=cluster.id,
                    name=cluster.name,
                    profiles=cluster_profiles,
                )
            )

        if time.monotonic() >= deadline:
            raise ModelTimeout(
                "Истекло общее время обработки резюме"
            )

        mark_ready(True)

        return RankResponse(clusters=result_clusters)

    except ModelUnavailable:
        mark_ready(False)
        raise

    finally:
        model_lock.release()
