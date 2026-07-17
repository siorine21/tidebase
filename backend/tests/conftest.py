"""テスト共通フィクスチャ。

Supabase には接続せず、リポジトリをインメモリ実装に差し替えて API を検証する。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.api import deps
from app.main import app
from app.timezone import JST

TEST_USER_ID = "11111111-1111-1111-1111-111111111111"


def _as_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=JST)


class FakeRecordsRepository:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def create(self, user_id: str, data: dict) -> dict:
        row = {
            **data,
            "id": str(uuid4()),
            "user_id": user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.rows[row["id"]] = row
        return row

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
        rows = [r for r in self.rows.values() if r["user_id"] == user_id]
        if spot_id is not None:
            rows = [r for r in rows if r.get("spot_id") == str(spot_id)]
        if is_skunked is not None:
            rows = [r for r in rows if r.get("is_skunked") == is_skunked]
        # 実装（PostgREST クエリ）と同じく JST 境界で比較する
        if date_from is not None:
            lower = datetime.combine(date_from, time.min, tzinfo=JST)
            rows = [r for r in rows if _as_dt(r["fished_at"]) >= lower]
        if date_to is not None:
            upper = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=JST)
            rows = [r for r in rows if _as_dt(r["fished_at"]) < upper]
        rows.sort(key=lambda r: _as_dt(r["fished_at"]), reverse=True)
        return rows[offset : offset + limit]

    def get(self, user_id: str, record_id: UUID) -> Optional[dict]:
        row = self.rows.get(str(record_id))
        if row and row["user_id"] == user_id:
            return row
        return None

    def update(self, user_id: str, record_id: UUID, data: dict) -> Optional[dict]:
        row = self.get(user_id, record_id)
        if row is None:
            return None
        row.update(data)
        return row

    def delete(self, user_id: str, record_id: UUID) -> bool:
        if self.get(user_id, record_id) is None:
            return False
        del self.rows[str(record_id)]
        return True

    def count_by_spot(self, user_id: str, spot_id: UUID) -> int:
        return len(
            [
                r
                for r in self.rows.values()
                if r["user_id"] == user_id and r.get("spot_id") == str(spot_id)
            ]
        )

    def reassign_spot(
        self,
        user_id: str,
        from_spot_id: UUID,
        to_spot_id: UUID,
        record_ids: Optional[list[UUID]] = None,
    ) -> int:
        targets = [
            r
            for r in self.rows.values()
            if r["user_id"] == user_id and r.get("spot_id") == str(from_spot_id)
        ]
        if record_ids is not None:
            wanted = {str(record_id) for record_id in record_ids}
            targets = [r for r in targets if r["id"] in wanted]
        for row in targets:
            row["spot_id"] = str(to_spot_id)
        return len(targets)


class FakeSpotsRepository:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def create(self, user_id: str, data: dict) -> dict:
        row = {
            **data,
            "id": str(uuid4()),
            "user_id": user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.rows[row["id"]] = row
        return row

    def list(self, user_id: str, *, water_type: Optional[str] = None) -> list[dict]:
        rows = [r for r in self.rows.values() if r["user_id"] == user_id]
        if water_type is not None:
            rows = [r for r in rows if r.get("water_type") == water_type]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return rows

    def get(self, user_id: str, spot_id: UUID) -> Optional[dict]:
        row = self.rows.get(str(spot_id))
        if row and row["user_id"] == user_id:
            return row
        return None

    def update(self, user_id: str, spot_id: UUID, data: dict) -> Optional[dict]:
        row = self.get(user_id, spot_id)
        if row is None:
            return None
        row.update(data)
        return row

    def delete(self, user_id: str, spot_id: UUID) -> bool:
        if self.get(user_id, spot_id) is None:
            return False
        del self.rows[str(spot_id)]
        return True


class FakeFishRepository:
    def __init__(self) -> None:
        self.species: dict[str, dict] = {}
        self.rules: list[dict] = []

    def get_species(self, user_id: str, species_id: UUID) -> Optional[dict]:
        row = self.species.get(str(species_id))
        if row and (row.get("user_id") is None or row["user_id"] == user_id):
            return row
        return None

    def list_rules(self, rule_group: str, region: str = "kanto") -> list[dict]:
        rows = [
            r
            for r in self.rules
            if r["rule_group"] == rule_group and r["region"] == region
        ]
        return sorted(rows, key=lambda r: r["sort_order"])


@pytest.fixture
def records_repo() -> FakeRecordsRepository:
    return FakeRecordsRepository()


@pytest.fixture
def spots_repo() -> FakeSpotsRepository:
    return FakeSpotsRepository()


@pytest.fixture
def fish_repo() -> FakeFishRepository:
    return FakeFishRepository()


@pytest.fixture
def client(records_repo, spots_repo, fish_repo):
    app.dependency_overrides[deps.get_current_user_id] = lambda: TEST_USER_ID
    app.dependency_overrides[deps.get_records_repo] = lambda: records_repo
    app.dependency_overrides[deps.get_spots_repo] = lambda: spots_repo
    app.dependency_overrides[deps.get_fish_repo] = lambda: fish_repo
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def anon_client():
    """認証依存を差し替えない素のクライアント（401 テスト用）。"""
    with TestClient(app) as test_client:
        yield test_client
