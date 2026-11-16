from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

UnknownReason = Literal["not_stated", "contradictory", "not_relevant", "unverified_evidence", "future_intent", "incomplete_document", "ambiguous_requirement"]


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
    unknown_reason: UnknownReason | None
    partial_reason: Literal["duration", "learning", "missing_parts"] | None

    @model_validator(mode="after")
    def reason_matches_status(self):
        # Reasons are explanatory metadata. A misplaced/null reason must not
        # discard a correctly structured set of statuses and source quotations.
        # The API still receives a canonical reason matching the final status.
        self.unknown_reason = (self.unknown_reason or "not_stated") if self.status == "unknown" else None
        self.partial_reason = (self.partial_reason or "missing_parts") if self.status == "partial" else None
        return self


class StopFactorAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    status: Literal["triggered", "not_triggered", "unknown"]
    evidence: list[str] = Field(max_length=3)
    unknown_reason: UnknownReason | None

    @model_validator(mode="after")
    def reason_matches_status(self):
        self.unknown_reason = (self.unknown_reason or "not_stated") if self.status == "unknown" else None
        return self


class ModelRating(BaseModel):
    """Модель сравнивает критерии; балл и объяснение вычисляет программа."""

    model_config = ConfigDict(extra="forbid", strict=True)

    assessments: list[CriterionAssessment] = Field(max_length=1000)
    stop_factors: list[StopFactorAssessment] = Field(max_length=100)


