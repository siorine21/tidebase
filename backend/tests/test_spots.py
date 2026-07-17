"""スポット API のテスト。"""
from uuid import uuid4

from app.api import tide as tide_api
from app.services.tide import TideService
from tests.test_tide import build_line

# 東京観測点（TK）から約 60km 圏内の座標（デフォルト）と、150km 圏外の座標
NEAR_TOKYO = {"latitude": 35.1234, "longitude": 139.5678}
SAPPORO = {"latitude": 43.06, "longitude": 141.35}


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

    def test_defaults_for_new_fields(self, client):
        body = _create_spot(client).json()
        assert body["low_tide_only"] is False
        assert body["visibility"] == "group"  # 確定仕様書 5 章
        assert body["spot_type"] is None

    def test_low_tide_only_flag(self, client):
        """US-201: 干潮時のみアクセス可の警告フラグ。"""
        body = _create_spot(client, low_tide_only=True, spot_type="surf").json()
        assert body["low_tide_only"] is True
        assert body["spot_type"] == "surf"

    def test_invalid_spot_type_is_rejected(self, client):
        assert _create_spot(client, spot_type="ocean").status_code == 422


class TestTideStationAssignment:
    def test_auto_assigned_for_saltwater_near_station(self, client):
        body = _create_spot(client).json()  # 東京湾近辺（TK から 150km 以内）
        assert body["tide_station_code"] == "TK"
        assert body["tide_station_name"] == "東京"

    def test_none_when_no_station_nearby(self, client):
        body = _create_spot(client, **SAPPORO).json()
        assert body["tide_station_code"] is None

    def test_none_for_freshwater(self, client):
        body = _create_spot(client, water_type="freshwater").json()
        assert body["tide_station_code"] is None

    def test_manual_code_is_preserved(self, client):
        body = _create_spot(client, tide_station_code="OS").json()
        assert body["tide_station_code"] == "OS"

    def test_recomputed_when_coords_change(self, client):
        spot_id = _create_spot(client, **SAPPORO).json()["id"]
        response = client.patch(f"/api/v1/spots/{spot_id}", json=NEAR_TOKYO)
        assert response.json()["tide_station_code"] == "TK"

    def test_cleared_when_changed_to_freshwater(self, client):
        spot_id = _create_spot(client).json()["id"]
        response = client.patch(
            f"/api/v1/spots/{spot_id}", json={"water_type": "freshwater"}
        )
        assert response.json()["tide_station_code"] is None

    def test_explicit_code_wins_over_recompute(self, client):
        spot_id = _create_spot(client).json()["id"]
        response = client.patch(
            f"/api/v1/spots/{spot_id}",
            json={**SAPPORO, "tide_station_code": "OS"},
        )
        assert response.json()["tide_station_code"] == "OS"


class TestSpotTide:
    def _tide_client(self, client):
        service = TideService(fetch_text=lambda station, year: build_line())
        from app.main import app

        app.dependency_overrides[tide_api.get_tide_service] = lambda: service
        return client

    def test_spot_tide(self, client):
        client = self._tide_client(client)
        spot_id = _create_spot(client).json()["id"]  # TK が自動設定される
        response = client.get(
            f"/api/v1/spots/{spot_id}/tide", params={"date": "2026-07-17"}
        )
        assert response.status_code == 200
        assert response.json()["station"] == "TK"

    def test_freshwater_spot_is_rejected(self, client):
        client = self._tide_client(client)
        spot_id = _create_spot(client, water_type="freshwater").json()["id"]
        response = client.get(
            f"/api/v1/spots/{spot_id}/tide", params={"date": "2026-07-17"}
        )
        assert response.status_code == 400

    def test_no_station_nearby_returns_404(self, client):
        client = self._tide_client(client)
        spot_id = _create_spot(client, **SAPPORO).json()["id"]
        response = client.get(
            f"/api/v1/spots/{spot_id}/tide", params={"date": "2026-07-17"}
        )
        assert response.status_code == 404


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
