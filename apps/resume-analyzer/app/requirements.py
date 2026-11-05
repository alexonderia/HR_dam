"""Requirements and result validation shared by both adapters."""

from app.errors import JobValidationError
from app.rank_models import ClusterRequest, ProfileRequest, RequirementsRequest


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
