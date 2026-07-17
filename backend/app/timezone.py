"""日付境界の基準タイムゾーン（DECISIONS D-011）。

「1日1釣行」や日付フィルタの境界はすべて JST 基準で扱う。
"""
from datetime import date, datetime, timedelta, timezone

JST = timezone(timedelta(hours=9), name="Asia/Tokyo")


def to_jst_date(value: datetime) -> date:
    """datetime を JST の日付に変換する。naive は JST とみなす。"""
    if value.tzinfo is None:
        value = value.replace(tzinfo=JST)
    return value.astimezone(JST).date()
