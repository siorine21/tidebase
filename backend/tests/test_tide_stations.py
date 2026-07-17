"""潮汐観測点マスタ・最近傍検索のテスト。"""
from app.services.tide_stations import (
    TideStation,
    haversine_km,
    load_stations,
    nearest_station,
    station_name,
)

TOKYO = TideStation(code="TK", name="東京", lat=35.6544, lng=139.7708)
OSAKA = TideStation(code="OS", name="大阪", lat=34.6533, lng=135.4342)


class TestHaversine:
    def test_zero_distance(self):
        assert haversine_km(35.0, 139.0, 35.0, 139.0) == 0

    def test_tokyo_osaka_is_about_400km(self):
        distance = haversine_km(TOKYO.lat, TOKYO.lng, OSAKA.lat, OSAKA.lng)
        assert 380 <= distance <= 420


class TestNearestStation:
    def test_picks_nearest(self):
        # 横浜近辺 → 東京の方が大阪より近い
        station = nearest_station(35.45, 139.64, stations=[TOKYO, OSAKA])
        assert station.code == "TK"

    def test_none_beyond_max_distance(self):
        # 札幌近辺 → どちらも 150km 圏外
        assert nearest_station(43.06, 141.35, stations=[TOKYO, OSAKA]) is None

    def test_custom_threshold(self):
        station = nearest_station(
            43.06, 141.35, stations=[TOKYO, OSAKA], max_distance_km=2000
        )
        assert station is not None


class TestMasterData:
    def test_master_loads_and_contains_tokyo(self):
        stations = load_stations()
        assert any(s.code == "TK" for s in stations)

    def test_station_name(self):
        assert station_name("TK") == "東京"
        assert station_name("ZZ") is None
        assert station_name(None) is None
