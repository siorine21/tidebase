"""スポット API（US-004、確定仕様書 14・15・17 章 + 設計補完書 3〜4 章）。"""
from datetime import date as date_type
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import get_current_user_id, get_records_repo, get_spots_repo
from app.api.tide import build_tide_response, get_tide_service
from app.models.spot import (
    SpotCreate,
    SpotDetailOut,
    SpotOut,
    SpotReassignRequest,
    SpotReassignResult,
    SpotUpdate,
    WaterType,
)
from app.models.tide import TideDayOut
from app.repositories.records import RecordsRepository
from app.repositories.spots import SpotsRepository
from app.services.tide import TideService
from app.services.tide_stations import nearest_station, station_name

router = APIRouter(prefix="/api/v1/spots", tags=["spots"])


def _resolve_station_code(data: dict) -> Optional[str]:
    """水域区分と座標から観測点記号を決める（設計補完書 3.2 章）。

    淡水は潮汐対象外のため常に None。近隣（150km 以内）に観測点が
    無い場合も None（マスタ拡充後に再計算可能）。
    """
    if data.get("water_type") == "freshwater":
        return None
    station = nearest_station(data["latitude"], data["longitude"])
    return station.code if station else None


def _with_station_name(row: dict) -> dict:
    return {**row, "tide_station_name": station_name(row.get("tide_station_code"))}


@router.post("", response_model=SpotOut, status_code=status.HTTP_201_CREATED)
def create_spot(
    payload: SpotCreate,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    data = payload.model_dump(mode="json")
    if payload.water_type == "freshwater":
        data["tide_station_code"] = None
    elif data.get("tide_station_code") is None:
        data["tide_station_code"] = _resolve_station_code(data)
    return _with_station_name(repo.create(user_id, data))


@router.get("", response_model=list[SpotOut])
def list_spots(
    water_type: Optional[WaterType] = None,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    return [_with_station_name(row) for row in repo.list(user_id, water_type=water_type)]


@router.get("/{spot_id}", response_model=SpotDetailOut)
def get_spot(
    spot_id: UUID,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
    records: RecordsRepository = Depends(get_records_repo),
):
    spot = repo.get(user_id, spot_id)
    if spot is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")
    return {
        **_with_station_name(spot),
        "record_count": records.count_by_spot(user_id, spot_id),
    }


@router.patch("/{spot_id}", response_model=SpotOut)
def update_spot(
    spot_id: UUID,
    payload: SpotUpdate,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    current = repo.get(user_id, spot_id)
    if current is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")

    changes = payload.model_dump(mode="json", exclude_unset=True)
    if not changes:
        return _with_station_name(current)

    # 座標・水域区分が変わったら観測点を再計算（明示指定があればそちらを優先）
    if "tide_station_code" not in changes and (
        {"latitude", "longitude", "water_type"} & changes.keys()
    ):
        merged = {**current, **changes}
        changes["tide_station_code"] = _resolve_station_code(merged)

    updated = repo.update(user_id, spot_id, changes)
    if updated is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")
    return _with_station_name(updated)


@router.delete("/{spot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_spot(
    spot_id: UUID,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
    records: RecordsRepository = Depends(get_records_repo),
):
    spot = repo.get(user_id, spot_id)
    if spot is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")

    # 釣果が紐付いている間は削除不可 → 一括変更へ誘導（確定仕様書 17.2 章）
    record_count = records.count_by_spot(user_id, spot_id)
    if record_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "釣果記録が紐付いているため削除できません。先にスポットを一括変更してください。",
                "record_count": record_count,
            },
        )
    repo.delete(user_id, spot_id)


@router.post("/{spot_id}/reassign", response_model=SpotReassignResult)
def reassign_spot_records(
    spot_id: UUID,
    payload: SpotReassignRequest,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
    records: RecordsRepository = Depends(get_records_repo),
):
    """釣果のスポット一括変更（確定仕様書 17.3 章）。"""
    if payload.target_spot_id == spot_id:
        raise HTTPException(status_code=400, detail="変更先が変更元と同じスポットです")
    if repo.get(user_id, spot_id) is None:
        raise HTTPException(status_code=404, detail="変更元スポットが見つかりません")
    if repo.get(user_id, payload.target_spot_id) is None:
        raise HTTPException(status_code=404, detail="変更先スポットが見つかりません")

    moved = records.reassign_spot(
        user_id, spot_id, payload.target_spot_id, payload.record_ids
    )
    return SpotReassignResult(moved=moved)


@router.get("/{spot_id}/tide", response_model=TideDayOut)
def get_spot_tide(
    spot_id: UUID,
    date: date_type = Query(description="対象日（YYYY-MM-DD）"),
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
    service: TideService = Depends(get_tide_service),
):
    """スポットの最寄り観測点で潮汐を返す（設計補完書 3.3 章）。"""
    spot = repo.get(user_id, spot_id)
    if spot is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")
    if spot.get("water_type") == "freshwater":
        raise HTTPException(status_code=400, detail="淡水スポットは潮汐データの対象外です")

    station_code = spot.get("tide_station_code")
    if not station_code:
        # 登録時に未設定でも、マスタ拡充後はここで解決できる
        station = nearest_station(spot["latitude"], spot["longitude"])
        if station is None:
            raise HTTPException(
                status_code=404, detail="近隣に潮汐観測点が見つかりません"
            )
        station_code = station.code

    return build_tide_response(service, station_code, date)
