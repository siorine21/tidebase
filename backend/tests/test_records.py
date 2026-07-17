"""釣果記録 CRUD API のテスト。"""
from uuid import uuid4

SPOT_ID = str(uuid4())


def _create(client, **overrides):
    payload = {
        "fished_at": "2026-07-17T06:30:00+09:00",
        "spot_id": SPOT_ID,
        "size_cm": 42.5,
        "catch_count": 2,
        "hit_range": "surface",
        "memo": "朝マズメにヒット",
    }
    payload.update(overrides)
    return client.post("/api/v1/records", json=payload)


class TestCreateRecord:
    def test_create_normal_record(self, client):
        response = _create(client)
        assert response.status_code == 201
        body = response.json()
        assert body["catch_count"] == 2
        assert body["size_cm"] == 42.5
        assert body["is_skunked"] is False
        assert body["visibility"] == "group"  # デフォルト（確定仕様書 5 章）
        assert body["id"]

    def test_skunked_record_forces_zero_catch(self, client):
        """ボウズは catch_count=0・魚情報なしで保存（確定仕様書 6.2 章）。"""
        response = _create(
            client,
            is_skunked=True,
            catch_count=3,
            fish_species_id=str(uuid4()),
            size_cm=50,
        )
        assert response.status_code == 201
        body = response.json()
        assert body["is_skunked"] is True
        assert body["catch_count"] == 0
        assert body["fish_species_id"] is None
        assert body["size_cm"] is None

    def test_zero_catch_without_skunked_is_rejected(self, client):
        response = _create(client, catch_count=0)
        assert response.status_code == 422

    def test_invalid_hit_range_is_rejected(self, client):
        response = _create(client, hit_range="deep")
        assert response.status_code == 422

    def test_requires_auth(self, anon_client):
        response = anon_client.post(
            "/api/v1/records", json={"fished_at": "2026-07-17T06:30:00+09:00"}
        )
        assert response.status_code == 401


class TestListRecords:
    def test_list_sorted_desc_and_filters(self, client):
        _create(client, fished_at="2026-07-15T06:00:00+09:00")
        _create(client, fished_at="2026-07-17T06:00:00+09:00")
        _create(
            client,
            fished_at="2026-07-16T06:00:00+09:00",
            spot_id=str(uuid4()),
            is_skunked=True,
            catch_count=0,
        )

        response = client.get("/api/v1/records")
        assert response.status_code == 200
        body = response.json()
        assert len(body) == 3
        fished_ats = [r["fished_at"] for r in body]
        assert fished_ats == sorted(fished_ats, reverse=True)

        response = client.get("/api/v1/records", params={"spot_id": SPOT_ID})
        assert len(response.json()) == 2

        response = client.get("/api/v1/records", params={"is_skunked": True})
        assert len(response.json()) == 1

        response = client.get(
            "/api/v1/records",
            params={"date_from": "2026-07-16", "date_to": "2026-07-16"},
        )
        assert len(response.json()) == 1

    def test_pagination(self, client):
        for day in (10, 11, 12):
            _create(client, fished_at=f"2026-07-{day}T06:00:00+09:00")
        response = client.get("/api/v1/records", params={"limit": 2, "offset": 2})
        assert len(response.json()) == 1


class TestGetRecord:
    def test_get_existing(self, client):
        record_id = _create(client).json()["id"]
        response = client.get(f"/api/v1/records/{record_id}")
        assert response.status_code == 200
        assert response.json()["id"] == record_id

    def test_get_missing_returns_404(self, client):
        response = client.get(f"/api/v1/records/{uuid4()}")
        assert response.status_code == 404


class TestUpdateRecord:
    def test_partial_update(self, client):
        record_id = _create(client).json()["id"]
        response = client.patch(
            f"/api/v1/records/{record_id}", json={"memo": "夕マズメに変更", "catch_count": 5}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["memo"] == "夕マズメに変更"
        assert body["catch_count"] == 5
        assert body["size_cm"] == 42.5  # 未指定フィールドは維持

    def test_update_to_skunked_clears_fish_fields(self, client):
        record_id = _create(client).json()["id"]
        response = client.patch(
            f"/api/v1/records/{record_id}", json={"is_skunked": True}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["catch_count"] == 0
        assert body["size_cm"] is None

    def test_inconsistent_update_is_rejected(self, client):
        record_id = _create(client).json()["id"]
        response = client.patch(
            f"/api/v1/records/{record_id}", json={"catch_count": 0}
        )
        assert response.status_code == 422

    def test_update_missing_returns_404(self, client):
        response = client.patch(f"/api/v1/records/{uuid4()}", json={"memo": "x"})
        assert response.status_code == 404


class TestDeleteRecord:
    def test_delete(self, client):
        record_id = _create(client).json()["id"]
        assert client.delete(f"/api/v1/records/{record_id}").status_code == 204
        assert client.get(f"/api/v1/records/{record_id}").status_code == 404

    def test_delete_missing_returns_404(self, client):
        assert client.delete(f"/api/v1/records/{uuid4()}").status_code == 404
