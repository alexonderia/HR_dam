
from app.config import settings
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
from app.readiness import is_ready, mark_ready, model_capacity, check_model_cancelled
from app.errors import InsufficientResumeTextError
from app.scoring import rank_profile
from app.evidence_scoring import validate_rating_source


RANK_TIMEOUT = settings.RANK_TIMEOUT_SECONDS


def analyze_resume_text(
    resume_text: str,
    requirements: RequirementsRequest,
    job_id: str,
) -> RankResponse:
    """Оценивает резюме по всем кластерам и профилям."""

    if not resume_text or len(resume_text.strip()) < 50:
        raise InsufficientResumeTextError()

    with model_capacity():
        result_clusters = []
        deadline = time.monotonic() + RANK_TIMEOUT

        try:
            if not is_ready():
                raise ModelUnavailable("Модель недоступна")

            for cluster in requirements.clusters:
                cluster_profiles = []

                for profile in cluster.profiles:
                    check_model_cancelled()
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
                    check_model_cancelled()
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
