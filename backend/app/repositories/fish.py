"""魚種マスタ・出世魚判定ルールの Supabase リポジトリ。"""
from typing import Optional
from uuid import UUID


class FishRepository:
    SPECIES_TABLE = "fish_species"
    RULES_TABLE = "fish_name_rules"

    def __init__(self, client) -> None:
        self._db = client

    def get_species(self, user_id: str, species_id: UUID) -> Optional[dict]:
        """システムデフォルト（user_id IS NULL）と自分の魚種のみ参照できる。"""
        result = (
            self._db.table(self.SPECIES_TABLE)
            .select("*")
            .eq("id", str(species_id))
            .or_(f"user_id.is.null,user_id.eq.{user_id}")
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def list_rules(self, rule_group: str, region: str = "kanto") -> list[dict]:
        result = (
            self._db.table(self.RULES_TABLE)
            .select("*")
            .eq("rule_group", rule_group)
            .eq("region", region)
            .order("sort_order")
            .execute()
        )
        return result.data
