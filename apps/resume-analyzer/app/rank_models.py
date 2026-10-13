from pydantic import BaseModel, Field


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


class ModelRating(BaseModel):
    score: float = Field(ge=0, le=100, allow_inf_nan=False)
    matched_keywords: list[str] = Field(default_factory=list)
    triggered_stop_factors: list[str] = Field(default_factory=list)
    explanation: str = Field(min_length=1)


class ProfileResponse(ModelRating):
    id: str
    position_name: str
    details: dict = Field(default_factory=dict)


class ClusterResponse(BaseModel):
    id: str
    name: str
    profiles: list[ProfileResponse]


class RankResponse(BaseModel):
    clusters: list[ClusterResponse]
