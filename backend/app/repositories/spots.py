"""スポット（spots）の Supabase リポジトリ。"""
from typing import Optional
from uuid import UUID


class SpotsRepository:
    TABLE = "spots"

    def __init__(self, client) -> None:
        self._db = client

    def create(self, user_id: str, data: dict) -> dict:
        result = self._db.table(self.TABLE).insert({**data, "user_id": user_id}).execute()
        return result.data[0]

    def list(self, user_id: str, *, water_type: Optional[str] = None) -> list[dict]:
        query = (
            self._db.table(self.TABLE)
            .select("*")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
        )
        if water_type is not None:
            query = query.eq("water_type", water_type)
        return query.execute().data

    def get(self, user_id: str, spot_id: UUID) -> Optional[dict]:
        result = (
            self._db.table(self.TABLE)
            .select("*")
            .eq("user_id", user_id)
            .eq("id", str(spot_id))
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def update(self, user_id: str, spot_id: UUID, data: dict) -> Optional[dict]:
        result = (
            self._db.table(self.TABLE)
            .update(data)
            .eq("user_id", user_id)
            .eq("id", str(spot_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def delete(self, user_id: str, spot_id: UUID) -> bool:
        result = (
            self._db.table(self.TABLE)
            .delete()
            .eq("user_id", user_id)
            .eq("id", str(spot_id))
            .execute()
        )
        return bool(result.data)
