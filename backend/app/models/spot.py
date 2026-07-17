"""スポット（spots）の Pydantic モデル。

仕様: 確定仕様書 v2.4 14章（水域区分）/ 15章（登録フロー・スキーマ）/ 17章（削除・一括変更）
+ 設計補完書 3〜4 章（spot_type / low_tide_only / visibility / tide_station_code）。
"""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

WaterType = Literal["saltwater", "brackish", "freshwater"]
SpotType = Literal["surf", "rock", "port", "managed", "river"]
Visibility = Literal["group", "private"]


class SpotBase(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    water_type: WaterType = "saltwater"
    spot_type: Optional[SpotType] = None
    low_tide_only: bool = False  # 干潮時のみアクセス可（US-201 ⚠️ 警告）
    visibility: Visibility = "group"
    # 未指定なら座標から自動設定（設計補完書 3.2 章）。手動上書き可
    tide_station_code: Optional[str] = Field(default=None, pattern=r"^[A-Z0-9]{2}$")


class SpotCreate(SpotBase):
    pass


class SpotUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    water_type: Optional[WaterType] = None
    spot_type: Optional[SpotType] = None
    low_tide_only: Optional[bool] = None
    visibility: Optional[Visibility] = None
    tide_station_code: Optional[str] = Field(default=None, pattern=r"^[A-Z0-9]{2}$")


class SpotOut(SpotBase):
    id: UUID
    user_id: UUID
    tide_station_name: Optional[str] = None  # マスタから解決（DB には持たない）
    created_at: Optional[datetime] = None


class SpotDetailOut(SpotOut):
    record_count: int = 0


class SpotReassignRequest(BaseModel):
    """釣果スポット一括変更（確定仕様書 17.3 章）。record_ids 省略時は全件。"""

    target_spot_id: UUID
    record_ids: Optional[list[UUID]] = None


class SpotReassignResult(BaseModel):
    moved: int
