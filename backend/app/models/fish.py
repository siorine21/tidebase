"""出世魚判定（設計補完書 5 章）のレスポンスモデル。"""
from typing import Optional

from pydantic import BaseModel


class FishNameSuggestion(BaseModel):
    suggested_name: Optional[str] = None
    rule_group: Optional[str] = None
    matched: bool = False
