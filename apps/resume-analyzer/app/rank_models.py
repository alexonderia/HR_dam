from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr


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


class ExtractedCandidate(BaseModel):
    last_name: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    phone: str | None = None


class ContactSource(BaseModel):
    source: Literal["resume_text"]
    confidence: Literal["high", "medium"]
    quote: str = Field(min_length=1, max_length=4000)
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)


class ContactFields(BaseModel):
    last_name: ContactSource | None
    first_name: ContactSource | None
    middle_name: ContactSource | None
    phone: ContactSource | None


class ContactDetails(BaseModel):
    version: Literal[1]
    method: Literal["rules-ru-v1"]
    text_status: Literal["present", "no_text"]
    name_status: Literal["extracted", "not_found", "ambiguous"]
    phone_status: Literal["extracted", "not_found", "unsupported", "ambiguous"]
    fields: ContactFields
    warnings: list[str]


class ContactsResponse(BaseModel):
    candidate: ExtractedCandidate
    contact_details: ContactDetails


class RankResponse(BaseModel):
    clusters: list[ClusterResponse]
    _restored_duration_ms: int = PrivateAttr(default=0)


class RankWithContactsResponse(RankResponse):
    candidate: ExtractedCandidate
    contact_details: ContactDetails
    analysis_duration_ms: int = Field(ge=0, le=2147483647)
