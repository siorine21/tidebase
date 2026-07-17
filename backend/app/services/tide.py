"""潮汐データ PoC — 気象庁 潮位表（推算値）テキストの取得・パース。

データソース（DECISIONS D-001）:
  https://www.data.jma.go.jp/gmd/kaiyou/data/db/tide/suisan/txt/{year}/{station}.txt

固定長フォーマット（1 行 = 1 日、気象庁公開仕様）:
  1-72   毎時潮位（0〜23時、3桁 cm × 24）
  73-74  年（西暦下2桁） / 75-76 月 / 77-78 日 / 79-80 地点記号
  81-108 満潮 4 回分（時刻 hhmm 4桁 + 潮位 3桁 = 7桁 × 4）
  109-136 干潮 4 回分（同上）
  欠測・該当なしは時刻 9999 / 潮位 999。

潮回りは月齢近似で判定（DECISIONS D-002）。
"""
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from functools import lru_cache
from typing import Callable, Optional

import httpx

JMA_TIDE_URL = "https://www.data.jma.go.jp/gmd/kaiyou/data/db/tide/suisan/txt/{year}/{station}.txt"

# 朔（新月）の基準時刻: 2000-01-06 18:14 UTC / 朔望月の平均周期
_NEW_MOON_EPOCH = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
_SYNODIC_MONTH = 29.530588853

LINE_LENGTH = 136


@dataclass
class TideEvent:
    time: Optional[str]  # "HH:MM"
    level_cm: Optional[int]


@dataclass
class TideDay:
    station: str
    day: date
    hourly_levels_cm: list[Optional[int]] = field(default_factory=list)
    high_tides: list[TideEvent] = field(default_factory=list)
    low_tides: list[TideEvent] = field(default_factory=list)


def moon_age(target: date) -> float:
    """正午（JST）時点の月齢（朔からの経過日数）。"""
    noon_jst = datetime(target.year, target.month, target.day, 3, 0, tzinfo=timezone.utc)
    elapsed_days = (noon_jst - _NEW_MOON_EPOCH).total_seconds() / 86400
    return round(elapsed_days % _SYNODIC_MONTH, 1)


def tide_type(target: date) -> str:
    """潮回り（大潮・中潮・小潮・長潮・若潮）を月齢近似で判定する。"""
    index = round(moon_age(target)) % 30
    if index in (0, 1, 2, 14, 15, 16, 17, 29):
        return "大潮"
    if index in (3, 4, 5, 6, 12, 13, 18, 19, 20, 21, 27, 28):
        return "中潮"
    if index in (7, 8, 9, 22, 23, 24):
        return "小潮"
    if index in (10, 25):
        return "長潮"
    return "若潮"  # 11, 26


def _parse_int(text: str) -> Optional[int]:
    text = text.strip()
    if not text or text == "999":
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _parse_event(chunk: str) -> Optional[TideEvent]:
    time_part, level_part = chunk[:4], chunk[4:7]
    if time_part.strip() in ("", "9999"):
        return None
    try:
        hour, minute = int(time_part[:2]), int(time_part[2:4])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return TideEvent(time=f"{hour:02d}:{minute:02d}", level_cm=_parse_int(level_part))


def parse_line(line: str) -> Optional[TideDay]:
    """潮位表 1 行（= 1 日分）をパースする。不正行は None。"""
    line = line.rstrip("\r\n").ljust(LINE_LENGTH)
    try:
        year = 2000 + int(line[72:74])
        month = int(line[74:76])
        day_of_month = int(line[76:78])
        parsed_date = date(year, month, day_of_month)
    except ValueError:
        return None

    hourly = [_parse_int(line[i * 3 : (i + 1) * 3]) for i in range(24)]
    highs = [event for i in range(4) if (event := _parse_event(line[80 + i * 7 : 87 + i * 7]))]
    lows = [event for i in range(4) if (event := _parse_event(line[108 + i * 7 : 115 + i * 7]))]

    return TideDay(
        station=line[78:80].strip(),
        day=parsed_date,
        hourly_levels_cm=hourly,
        high_tides=highs,
        low_tides=lows,
    )


def _default_fetch(station: str, year: int) -> str:
    url = JMA_TIDE_URL.format(year=year, station=station)
    response = httpx.get(url, timeout=15)
    response.raise_for_status()
    return response.text


@lru_cache(maxsize=8)
def _cached_year_text(station: str, year: int) -> str:
    return _default_fetch(station, year)


class TideService:
    """観測点 + 日付から 1 日分の潮汐データを返す。

    fetch_text を差し替え可能にしてテスト・キャッシュ戦略を切り離す。
    """

    def __init__(self, fetch_text: Optional[Callable[[str, int], str]] = None) -> None:
        self._fetch_text = fetch_text or _cached_year_text

    def get_day(self, station: str, target: date) -> Optional[TideDay]:
        text = self._fetch_text(station, target.year)
        for line in text.splitlines():
            parsed = parse_line(line)
            if parsed and parsed.day == target:
                return parsed
        return None
