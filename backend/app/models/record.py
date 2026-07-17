"""釣果記録（fishing_records）の Pydantic モデル。

仕様: 確定仕様書 v2.4 1章（魚種・数量メモ）/ 6章（ボウズ記録）/ 5章（公開範囲）。
"""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

# 表層 / 中層 / 底層 / ボトム直撃（DECISIONS D-005）
HitRange = Literal["surface", "middle", "bottom", "bottom_direct"]
Visibility = Literal["group", "private"]


class RecordBase(BaseModel):
    fished_at: datetime
    spot_id: Optional[UUID] = None
    fish_species_id: Optional[UUID] = None
    # 出世魚の採用呼称（設計補完書 5 章）。集計は fish_species_id、表示はこちら
    fish_display_name: Optional[str] = Field(default=None, max_length=50)
    size_cm: Optional[float] = Field(default=None, ge=0, le=999)
    catch_count: int = Field(default=1, ge=0)
    quantity_note: Optional[str] = Field(default=None, max_length=200)
    is_skunked: bool = False
    recipe_id: Optional[UUID] = None
    hit_range: Optional[HitRange] = None
    memo: Optional[str] = Field(default=None, max_length=2000)
    visibility: Visibility = "group"
    tide_snapshot: Optional[dict] = None
    weather_snapshot: Optional[dict] = None


class RecordCreate(RecordBase):
    @model_validator(mode="after")
    def validate_skunked(self) -> "RecordCreate":
        if self.is_skunked:
            # ボウズは catch_count = 0 で保存し、魚情報は持たない（確定仕様書 6.2 章）
            self.catch_count = 0
            self.fish_species_id = None
            self.fish_display_name = None
            self.size_cm = None
        elif self.catch_count < 1:
            raise ValueError("ボウズでない場合、catch_count は 1 以上が必要です")
        return self


class RecordUpdate(BaseModel):
    fished_at: Optional[datetime] = None
    spot_id: Optional[UUID] = None
    fish_species_id: Optional[UUID] = None
    fish_display_name: Optional[str] = Field(default=None, max_length=50)
    size_cm: Optional[float] = Field(default=None, ge=0, le=999)
    catch_count: Optional[int] = Field(default=None, ge=0)
    quantity_note: Optional[str] = Field(default=None, max_length=200)
    is_skunked: Optional[bool] = None
    recipe_id: Optional[UUID] = None
    hit_range: Optional[HitRange] = None
    memo: Optional[str] = Field(default=None, max_length=2000)
    visibility: Optional[Visibility] = None
    tide_snapshot: Optional[dict] = None
    weather_snapshot: Optional[dict] = None


class RecordOut(RecordBase):
    id: UUID
    user_id: UUID
    created_at: Optional[datetime] = None
