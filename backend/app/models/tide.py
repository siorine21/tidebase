"""潮汐データ PoC のレスポンスモデル。"""
from datetime import date as date_type
from typing import Optional

from pydantic import BaseModel


class TideEvent(BaseModel):
    time: Optional[str] = None  # "HH:MM"
    level_cm: Optional[int] = None


class TideDayOut(BaseModel):
    station: str
    date: date_type
    tide_type: str  # 大潮 / 中潮 / 小潮 / 長潮 / 若潮
    moon_age: float
    hourly_levels_cm: list[Optional[int]]  # 0時〜23時の毎時潮位
    high_tides: list[TideEvent]
    low_tides: list[TideEvent]
    source: str
