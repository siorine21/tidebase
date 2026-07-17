"""潮汐観測点マスタ（気象庁 潮位表掲載地点）と最近傍検索（設計補完書 3 章）。

マスタは backend/app/data/jma_tide_stations.json に静的保持する。
一覧の再生成は scripts/generate_tide_stations.py を参照
（開発サンドボックスから気象庁サイトへ到達できないため、初期データは
東京（TK）のみ。ユーザー環境でスクリプトを実行して全地点に差し替える）。
"""
import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional, Sequence

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "jma_tide_stations.json"

# これ以上離れた観測点は「最寄り」として不適切なので割り当てない
MAX_DISTANCE_KM = 150.0

_EARTH_RADIUS_KM = 6371.0


@dataclass(frozen=True)
class TideStation:
    code: str
    name: str
    lat: float
    lng: float


@lru_cache
def load_stations() -> tuple[TideStation, ...]:
    raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    return tuple(
        TideStation(code=s["code"], name=s["name"], lat=s["lat"], lng=s["lng"])
        for s in raw
    )


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def nearest_station(
    lat: float,
    lng: float,
    *,
    stations: Optional[Sequence[TideStation]] = None,
    max_distance_km: float = MAX_DISTANCE_KM,
) -> Optional[TideStation]:
    """最寄り観測点を返す。max_distance_km 以内に無ければ None。"""
    candidates = stations if stations is not None else load_stations()
    best: Optional[TideStation] = None
    best_distance = max_distance_km
    for station in candidates:
        distance = haversine_km(lat, lng, station.lat, station.lng)
        if distance <= best_distance:
            best = station
            best_distance = distance
    return best


def station_name(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    for station in load_stations():
        if station.code == code:
            return station.name
    return None
