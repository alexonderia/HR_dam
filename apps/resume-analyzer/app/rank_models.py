from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProfileRequest(BaseModel):
    id: str
    position_name: str
    education: str | None = None
    experience: str | None = None
    keywords: list[str] = Field(default_factory=list)
    stop_factors: list[str] = Field(default_factory=list)
    comment: str | None = None


class ClusterRequest(BaseModel):
    id: str
    name: str
    track: str | None = None
    comment: str | None = None
    profiles: list[ProfileRequest]


class RequirementsRequest(BaseModel):
    clusters: list[ClusterRequest] = Field(min_length=1)


class CriterionAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    status: Literal["met", "partial", "not_met", "unknown"]
    evidence: list[str] = Field(max_length=3)


class StopFactorAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    status: Literal["triggered", "not_triggered", "unknown"]
    evidence: list[str] = Field(max_length=3)


class ModelRating(BaseModel):
    """Модель сравнивает критерии; балл и объяснение вычисляет программа."""

    model_config = ConfigDict(extra="forbid", strict=True)

    assessments: list[CriterionAssessment] = Field(max_length=1000)
    stop_factors: list[StopFactorAssessment] = Field(max_length=100)


class ProfileResponse(BaseModel):
    id: str
    position_name: str
    score: float = Field(ge=0, le=100, allow_inf_nan=False)
    matched_keywords: list[str] = Field(default_factory=list)
    triggered_stop_factors: list[str] = Field(default_factory=list)
    explanation: str = Field(min_length=1)


    details: dict = Field(default_factory=dict)


class ClusterResponse(BaseModel):
    id: str
    name: str
    profiles: list[ProfileResponse]


class RankResponse(BaseModel):
    clusters: list[ClusterResponse]
