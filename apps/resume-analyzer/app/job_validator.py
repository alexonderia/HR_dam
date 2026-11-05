"""Проверка входящих заданий RabbitMQ."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    field_validator,
)

from pydantic import model_validator

class CandidateHint(BaseModel):
    last_name: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    phone: str | None = None


class ResumeFile(BaseModel):
    id: UUID
    file_id: UUID
    source_path: str = Field(min_length=1, max_length=2048)
    file_name: str = Field(min_length=1, max_length=180)
    mime_type: str = Field(max_length=100)
    size_bytes: int = Field(gt=0, le=50 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bucket: str = Field(min_length=1, max_length=255)
    object_key: str = Field(min_length=1, max_length=2048)
    download_url: HttpUrl
    download_url_expires_at: datetime
    candidate_hint: CandidateHint
    target_resume_id: UUID | None = None
    target_updated_at: str | None = None

    @field_validator("download_url_expires_at")
    @classmethod
    def validate_expiration(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Expiration must include timezone")
        return value


class Profile(BaseModel):
    id: UUID
    cluster_id: UUID
    position_name: str = Field(min_length=1)
    education: str = ""
    experience: str = ""
    keywords: list[str] = Field(default_factory=list)
    stop_factors: list[str] = Field(default_factory=list)
    comment: str = ""
    is_active: bool = True


class Cluster(BaseModel):
    id: UUID
    name: str = Field(min_length=1)
    track: str = ""
    comment: str = ""
    is_active: bool = True
    profiles: list[Profile] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_profiles(self):
        profile_ids = set()

        for profile in self.profiles:
            if profile.cluster_id != self.id:
                raise ValueError(
                    "Profile cluster_id does not match cluster id"
                )

            if profile.id in profile_ids:
                raise ValueError("Duplicate profile id")

            profile_ids.add(profile.id)

        return self


class AnalysisJob(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: Literal[1]
    job_id: UUID
    batch_id: UUID
    item_id: UUID
    attempt: int = Field(ge=1, le=100)
    file: ResumeFile
    requirements: list[Cluster] = Field(min_length=1)

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("Unsupported job version")
        return value

    @field_validator("attempt", mode="before")
    @classmethod
    def validate_attempt(cls, value):
        if type(value) is not int:
            raise ValueError("Invalid attempt")
        return value

    @model_validator(mode="after")
    def validate_clusters(self):
        cluster_ids = set()
        profile_ids = set()

        for cluster in self.requirements:
            if cluster.id in cluster_ids:
                raise ValueError("Duplicate cluster id")

            cluster_ids.add(cluster.id)

            for profile in cluster.profiles:
                if profile.id in profile_ids:
                    raise ValueError("Duplicate profile id across clusters")

                profile_ids.add(profile.id)

        return self


def validate_analysis_job(job: dict) -> dict:
    """Проверяет задание, не изменяя исходный JSON."""
    AnalysisJob.model_validate(job, strict=False)
    return job
