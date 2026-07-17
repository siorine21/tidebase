"""潮汐データ PoC のテスト（気象庁フォーマットのフィクスチャで検証）。"""
from datetime import date

import pytest

from app.api import tide as tide_api
from app.main import app
from app.services.tide import TideService, moon_age, parse_line, tide_type
from fastapi.testclient import TestClient

HOURLY = [
    150, 162, 170, 172, 168, 158, 144, 128, 112, 100, 94, 96,
    106, 122, 140, 156, 168, 174, 172, 162, 148, 132, 118, 108,
]


def build_line(
    *,
    year="26",
    month="07",
    day="17",
    station="TK",
    highs=("0330175", "1750176"),
    lows=("1030 92", "2300105"),
):
    hourly = "".join(f"{v:3d}" for v in HOURLY)
    high_part = "".join(highs) + "9999999" * (4 - len(highs))
    low_part = "".join(lows) + "9999999" * (4 - len(lows))
    return hourly + year + month + day + station + high_part + low_part


class TestParseLine:
    def test_parses_full_line(self):
        parsed = parse_line(build_line())
        assert parsed is not None
        assert parsed.station == "TK"
        assert parsed.day == date(2026, 7, 17)
        assert parsed.hourly_levels_cm == HOURLY
        assert [(e.time, e.level_cm) for e in parsed.high_tides] == [
            ("03:30", 175),
            ("17:50", 176),
        ]
        assert [(e.time, e.level_cm) for e in parsed.low_tides] == [
            ("10:30", 92),
            ("23:00", 105),
        ]

    def test_missing_events_are_skipped(self):
        parsed = parse_line(build_line(highs=("0330175",), lows=()))
        assert len(parsed.high_tides) == 1
        assert parsed.low_tides == []

    def test_missing_hourly_level(self):
        line = build_line()
        line = "999" + line[3:]  # 0 時が欠測
        parsed = parse_line(line)
        assert parsed.hourly_levels_cm[0] is None
        assert parsed.hourly_levels_cm[1] == HOURLY[1]

    def test_invalid_line_returns_none(self):
        assert parse_line("") is None
        assert parse_line("garbage") is None


class TestTideType:
    def test_new_moon_is_spring_tide(self):
        # 2026-01-19 が朔（新月）近傍 → 大潮
        assert tide_type(date(2026, 1, 19)) == "大潮"

    def test_moon_age_range(self):
        age = moon_age(date(2026, 7, 17))
        assert 0 <= age < 29.6

    def test_all_types_appear_within_a_month(self):
        types = {tide_type(date(2026, 7, d)) for d in range(1, 31)}
        assert types == {"大潮", "中潮", "小潮", "長潮", "若潮"}


class TestTideService:
    def test_get_day_finds_target_date(self):
        text = "\n".join(
            [build_line(day="16"), build_line(day="17"), build_line(day="18")]
        )
        service = TideService(fetch_text=lambda station, year: text)
        day = service.get_day("TK", date(2026, 7, 17))
        assert day is not None
        assert day.day == date(2026, 7, 17)

    def test_get_day_missing_date_returns_none(self):
        service = TideService(fetch_text=lambda station, year: build_line(day="16"))
        assert service.get_day("TK", date(2026, 7, 17)) is None


class TestTideEndpoint:
    @pytest.fixture
    def client(self):
        service = TideService(fetch_text=lambda station, year: build_line())
        app.dependency_overrides[tide_api.get_tide_service] = lambda: service
        with TestClient(app) as test_client:
            yield test_client
        app.dependency_overrides.clear()

    def test_get_tide(self, client):
        response = client.get(
            "/api/v1/tide", params={"station": "TK", "date": "2026-07-17"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["station"] == "TK"
        assert body["date"] == "2026-07-17"
        assert body["tide_type"] in {"大潮", "中潮", "小潮", "長潮", "若潮"}
        assert len(body["hourly_levels_cm"]) == 24
        assert body["high_tides"][0] == {"time": "03:30", "level_cm": 175}
        assert "jma.go.jp" in body["source"]

    def test_missing_date_returns_404(self, client):
        response = client.get(
            "/api/v1/tide", params={"station": "TK", "date": "2026-08-01"}
        )
        assert response.status_code == 404

    def test_invalid_station_is_rejected(self, client):
        response = client.get(
            "/api/v1/tide", params={"station": "tokyo", "date": "2026-07-17"}
        )
        assert response.status_code == 422
