"""潮汐データ PoC API（US-002）。認証不要の公開データ（DECISIONS D-009）。

スポット紐付きの潮汐は GET /api/v1/spots/{spot_id}/tide（要認証）を参照。
"""
from datetime import date as date_type

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.models.tide import TideDayOut, TideEvent
from app.services.tide import TideService, moon_age, source_url, tide_type

router = APIRouter(prefix="/api/v1/tide", tags=["tide"])


def get_tide_service() -> TideService:
    return TideService()


def build_tide_response(
    service: TideService, station: str, date: date_type
) -> TideDayOut:
    """観測点 + 日付から潮汐レスポンスを構築する（spots ルーターと共用）。"""
    try:
        day = service.get_day(station, date)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(
                status_code=404, detail=f"観測地点 {station} の {date.year} 年データがありません"
            )
        raise HTTPException(status_code=502, detail="潮汐データの取得に失敗しました")
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="潮汐データの取得に失敗しました")

    if day is None:
        raise HTTPException(status_code=404, detail=f"{date} の潮汐データが見つかりません")

    return TideDayOut(
        station=day.station,
        date=day.day,
        tide_type=tide_type(date),
        moon_age=moon_age(date),
        hourly_levels_cm=day.hourly_levels_cm,
        high_tides=[TideEvent(time=e.time, level_cm=e.level_cm) for e in day.high_tides],
        low_tides=[TideEvent(time=e.time, level_cm=e.level_cm) for e in day.low_tides],
        source=source_url(station, date.year),
    )


@router.get("", response_model=TideDayOut)
def get_tide(
    station: str = Query(
        description="気象庁の潮位観測地点記号（2文字、例: TK=東京）",
        pattern=r"^[A-Z0-9]{2}$",
    ),
    date: date_type = Query(description="対象日（YYYY-MM-DD）"),
    service: TideService = Depends(get_tide_service),
):
    return build_tide_response(service, station, date)
