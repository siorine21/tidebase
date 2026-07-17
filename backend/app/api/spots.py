"""スポット API（US-004、確定仕様書 14・15・17 章）。"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_user_id, get_records_repo, get_spots_repo
from app.models.spot import (
    SpotCreate,
    SpotDetailOut,
    SpotOut,
    SpotReassignRequest,
    SpotReassignResult,
    SpotUpdate,
    WaterType,
)
from app.repositories.records import RecordsRepository
from app.repositories.spots import SpotsRepository

router = APIRouter(prefix="/api/v1/spots", tags=["spots"])


@router.post("", response_model=SpotOut, status_code=status.HTTP_201_CREATED)
def create_spot(
    payload: SpotCreate,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    return repo.create(user_id, payload.model_dump(mode="json"))


@router.get("", response_model=list[SpotOut])
def list_spots(
    water_type: Optional[WaterType] = None,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    return repo.list(user_id, water_type=water_type)


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
    return {**spot, "record_count": records.count_by_spot(user_id, spot_id)}


@router.patch("/{spot_id}", response_model=SpotOut)
def update_spot(
    spot_id: UUID,
    payload: SpotUpdate,
    user_id: str = Depends(get_current_user_id),
    repo: SpotsRepository = Depends(get_spots_repo),
):
    changes = payload.model_dump(mode="json", exclude_unset=True)
    if not changes:
        spot = repo.get(user_id, spot_id)
        if spot is None:
            raise HTTPException(status_code=404, detail="スポットが見つかりません")
        return spot
    updated = repo.update(user_id, spot_id, changes)
    if updated is None:
        raise HTTPException(status_code=404, detail="スポットが見つかりません")
    return updated


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
