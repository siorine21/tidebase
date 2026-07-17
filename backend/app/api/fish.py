"""出世魚判定 API（US-101 / US-205、設計補完書 5 章）。

提案表示にとどめ強制はしない（確定仕様書 1.2 章）。
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_current_user_id, get_fish_repo
from app.models.fish import FishNameSuggestion
from app.repositories.fish import FishRepository

router = APIRouter(prefix="/api/v1/fish-name", tags=["fish"])


def _match_rule(rules: list[dict], size_cm: float) -> dict | None:
    for rule in rules:
        min_cm = rule.get("min_cm")
        max_cm = rule.get("max_cm")
        if min_cm is not None and size_cm < float(min_cm):
            continue
        if max_cm is not None and size_cm >= float(max_cm):
            continue
        return rule
    return None


@router.get("/suggest", response_model=FishNameSuggestion)
def suggest_fish_name(
    fish_species_id: UUID,
    size_cm: float = Query(ge=0, le=999),
    user_id: str = Depends(get_current_user_id),
    repo: FishRepository = Depends(get_fish_repo),
):
    species = repo.get_species(user_id, fish_species_id)
    if species is None:
        raise HTTPException(status_code=404, detail="魚種が見つかりません")

    rule_group = species.get("name_rule_group")
    if not rule_group:
        return FishNameSuggestion(matched=False)  # 出世魚対象外の魚種

    rule = _match_rule(repo.list_rules(rule_group), size_cm)
    if rule is None:
        return FishNameSuggestion(rule_group=rule_group, matched=False)
    return FishNameSuggestion(
        suggested_name=rule["display_name"], rule_group=rule_group, matched=True
    )
