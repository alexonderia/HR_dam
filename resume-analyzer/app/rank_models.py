from pydantic import BaseModel
from typing import Optional

#модели для запроса
class ProfileRequest(BaseModel):
    id:str
    position_name:str
    education:Optional[str] = None
    experience:Optional[str] = None
    keywords:Optional[list[str]] = []
    stop_factors:Optional[list[str]] = []
    comment:Optional[str] = None

class ClusterRequest(BaseModel):
    id:str
    name:str
    track:Optional[str] = None
    comment:Optional[str] = None
    profiles:list[ProfileRequest]

class RequirementsRequest(BaseModel):
    clusters:list[ClusterRequest]

#модели для ответа
class ProfileResponse(BaseModel):
    id:str
    position_name:str
    score:float
    matched_keywords:Optional[list[str]] = None
    triggered_stop_factors:Optional[list[str]] = None
    explanation:Optional[str] = None

class ClusterResponse(BaseModel):
    id:str
    name:str
    profiles:list[ProfileResponse]

class RankResponse(BaseModel):
    clusters:list[ClusterResponse]