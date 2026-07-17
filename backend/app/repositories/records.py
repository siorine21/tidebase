"""釣果記録（fishing_records）の Supabase リポジトリ。

RLS が本線の防御。ここでの user_id フィルタは多層防御（DECISIONS D-003）。
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional
from uuid import UUID


class RecordsRepository:
    TABLE = "fishing_records"

    def __init__(self, client) -> None:
        self._db = client

    def create(self, user_id: str, data: dict) -> dict:
        result = self._db.table(self.TABLE).insert({**data, "user_id": user_id}).execute()
        return result.data[0]

    def list(
        self,
        user_id: str,
        *,
        spot_id: Optional[UUID] = None,
        is_skunked: Optional[bool] = None,
        date_from: Optional[date] = None,
        date_to: Optional[date] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        query = (
            self._db.table(self.TABLE)
            .select("*")
            .eq("user_id", user_id)
            .order("fished_at", desc=True)
            .range(offset, offset + limit - 1)
        )
        if spot_id is not None:
            query = query.eq("spot_id", str(spot_id))
        if is_skunked is not None:
            query = query.eq("is_skunked", is_skunked)
        if date_from is not None:
            query = query.gte("fished_at", date_from.isoformat())
        if date_to is not None:
            query = query.lt("fished_at", (date_to + timedelta(days=1)).isoformat())
        return query.execute().data

    def get(self, user_id: str, record_id: UUID) -> Optional[dict]:
        result = (
            self._db.table(self.TABLE)
            .select("*")
            .eq("user_id", user_id)
            .eq("id", str(record_id))
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def update(self, user_id: str, record_id: UUID, data: dict) -> Optional[dict]:
        result = (
            self._db.table(self.TABLE)
            .update(data)
            .eq("user_id", user_id)
            .eq("id", str(record_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def delete(self, user_id: str, record_id: UUID) -> bool:
        result = (
            self._db.table(self.TABLE)
            .delete()
            .eq("user_id", user_id)
            .eq("id", str(record_id))
            .execute()
        )
        return bool(result.data)

    def count_by_spot(self, user_id: str, spot_id: UUID) -> int:
        result = (
            self._db.table(self.TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("spot_id", str(spot_id))
            .execute()
        )
        return result.count or 0

    def reassign_spot(
        self,
        user_id: str,
        from_spot_id: UUID,
        to_spot_id: UUID,
        record_ids: Optional[list[UUID]] = None,
    ) -> int:
        query = (
            self._db.table(self.TABLE)
            .update({"spot_id": str(to_spot_id)})
            .eq("user_id", user_id)
            .eq("spot_id", str(from_spot_id))
        )
        if record_ids:
            query = query.in_("id", [str(record_id) for record_id in record_ids])
        result = query.execute()
        return len(result.data or [])
