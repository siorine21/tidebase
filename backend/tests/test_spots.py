"""スポット API のテスト。"""
from uuid import uuid4


def _create_spot(client, **overrides):
    payload = {
        "name": "○○港 北堤防",
        "latitude": 35.1234,
        "longitude": 139.5678,
        "water_type": "saltwater",
    }
    payload.update(overrides)
    return client.post("/api/v1/spots", json=payload)


def _create_record_at(client, spot_id, **overrides):
    payload = {
        "fished_at": "2026-07-17T06:30:00+09:00",
        "spot_id": spot_id,
        "catch_count": 1,
    }
    payload.update(overrides)
    return client.post("/api/v1/records", json=payload)


class TestCreateSpot:
    def test_create(self, client):
        response = _create_spot(client)
        assert response.status_code == 201
        body = response.json()
        assert body["name"] == "○○港 北堤防"
        assert body["water_type"] == "saltwater"

    def test_name_is_optional(self, client):
        response = _create_spot(client, name=None)
        assert response.status_code == 201

    def test_invalid_water_type_is_rejected(self, client):
        response = _create_spot(client, water_type="pond")
        assert response.status_code == 422

    def test_invalid_latitude_is_rejected(self, client):
        response = _create_spot(client, latitude=123.0)
        assert response.status_code == 422

    def test_requires_auth(self, anon_client):
        assert anon_client.get("/api/v1/spots").status_code == 401


class TestListSpots:
    def test_list_and_filter_by_water_type(self, client):
        _create_spot(client, water_type="saltwater")
        _create_spot(client, name="エリアA", water_type="freshwater")

        assert len(client.get("/api/v1/spots").json()) == 2
        response = client.get("/api/v1/spots", params={"water_type": "freshwater"})
        assert [s["name"] for s in response.json()] == ["エリアA"]


class TestGetSpot:
    def test_detail_includes_record_count(self, client):
        spot_id = _create_spot(client).json()["id"]
        _create_record_at(client, spot_id)
        _create_record_at(client, spot_id)

        response = client.get(f"/api/v1/spots/{spot_id}")
        assert response.status_code == 200
        assert response.json()["record_count"] == 2

    def test_missing_returns_404(self, client):
        assert client.get(f"/api/v1/spots/{uuid4()}").status_code == 404


class TestUpdateSpot:
    def test_update_name_coords_water_type(self, client):
        """名前・座標・水域区分すべて変更可能（確定仕様書 17.1 章）。"""
        spot_id = _create_spot(client).json()["id"]
        response = client.patch(
            f"/api/v1/spots/{spot_id}",
            json={"name": "新名称", "latitude": 34.0, "water_type": "brackish"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "新名称"
        assert body["latitude"] == 34.0
        assert body["water_type"] == "brackish"
        assert body["longitude"] == 139.5678


class TestDeleteSpot:
    def test_delete_without_records(self, client):
        spot_id = _create_spot(client).json()["id"]
        assert client.delete(f"/api/v1/spots/{spot_id}").status_code == 204
        assert client.get(f"/api/v1/spots/{spot_id}").status_code == 404

    def test_delete_with_records_returns_409(self, client):
        """釣果紐付き時は削除不可（確定仕様書 17.2 章）。"""
        spot_id = _create_spot(client).json()["id"]
        _create_record_at(client, spot_id)

        response = client.delete(f"/api/v1/spots/{spot_id}")
        assert response.status_code == 409
        assert response.json()["detail"]["record_count"] == 1

    def test_delete_after_reassign(self, client):
        """一括変更 → 削除のフロー（確定仕様書 17.2-17.4 章）。"""
        old_spot = _create_spot(client).json()["id"]
        new_spot = _create_spot(client, name="移行先").json()["id"]
        _create_record_at(client, old_spot)
        _create_record_at(client, old_spot)

        response = client.post(
            f"/api/v1/spots/{old_spot}/reassign", json={"target_spot_id": new_spot}
        )
        assert response.status_code == 200
        assert response.json()["moved"] == 2

        assert client.delete(f"/api/v1/spots/{old_spot}").status_code == 204
        assert client.get(f"/api/v1/spots/{new_spot}").json()["record_count"] == 2


class TestReassign:
    def test_reassign_selected_records_only(self, client):
        old_spot = _create_spot(client).json()["id"]
        new_spot = _create_spot(client, name="移行先").json()["id"]
        record_1 = _create_record_at(client, old_spot).json()["id"]
        _create_record_at(client, old_spot)

        response = client.post(
            f"/api/v1/spots/{old_spot}/reassign",
            json={"target_spot_id": new_spot, "record_ids": [record_1]},
        )
        assert response.json()["moved"] == 1
        assert client.get(f"/api/v1/spots/{old_spot}").json()["record_count"] == 1

    def test_reassign_to_same_spot_is_rejected(self, client):
        spot_id = _create_spot(client).json()["id"]
        response = client.post(
            f"/api/v1/spots/{spot_id}/reassign", json={"target_spot_id": spot_id}
        )
        assert response.status_code == 400

    def test_reassign_to_missing_target_returns_404(self, client):
        spot_id = _create_spot(client).json()["id"]
        response = client.post(
            f"/api/v1/spots/{spot_id}/reassign", json={"target_spot_id": str(uuid4())}
        )
        assert response.status_code == 404
