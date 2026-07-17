"""スポット（spots）の Pydantic モデル。

仕様: 確定仕様書 v2.4 14章（水域区分）/ 15章（登録フロー・スキーマ）/ 17章（削除・一括変更）。
"""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

WaterType = Literal["saltwater", "brackish", "freshwater"]


class SpotBase(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    water_type: WaterType = "saltwater"


class SpotCreate(SpotBase):
    pass


class SpotUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    water_type: Optional[WaterType] = None


class SpotOut(SpotBase):
    id: UUID
    user_id: UUID
    created_at: Optional[datetime] = None


class SpotDetailOut(SpotOut):
    record_count: int = 0


class SpotReassignRequest(BaseModel):
    """釣果スポット一括変更（確定仕様書 17.3 章）。record_ids 省略時は全件。"""

    target_spot_id: UUID
    record_ids: Optional[list[UUID]] = None


class SpotReassignResult(BaseModel):
    moved: int
