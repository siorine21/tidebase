"""釣果記録 CRUD API（US-001 / US-007）。"""
from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError

from app.api.deps import get_current_user_id, get_records_repo
from app.models.record import RecordCreate, RecordOut, RecordUpdate
from app.repositories.records import RecordsRepository

router = APIRouter(prefix="/api/v1/records", tags=["records"])


@router.post("", response_model=RecordOut, status_code=status.HTTP_201_CREATED)
def create_record(
    payload: RecordCreate,
    user_id: str = Depends(get_current_user_id),
    repo: RecordsRepository = Depends(get_records_repo),
):
    return repo.create(user_id, payload.model_dump(mode="json"))


@router.get("", response_model=list[RecordOut])
def list_records(
    spot_id: Optional[UUID] = None,
    is_skunked: Optional[bool] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user_id: str = Depends(get_current_user_id),
    repo: RecordsRepository = Depends(get_records_repo),
):
    return repo.list(
        user_id,
        spot_id=spot_id,
        is_skunked=is_skunked,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )


@router.get("/{record_id}", response_model=RecordOut)
def get_record(
    record_id: UUID,
    user_id: str = Depends(get_current_user_id),
    repo: RecordsRepository = Depends(get_records_repo),
):
    record = repo.get(user_id, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="釣果記録が見つかりません")
    return record


@router.patch("/{record_id}", response_model=RecordOut)
def update_record(
    record_id: UUID,
    payload: RecordUpdate,
    user_id: str = Depends(get_current_user_id),
    repo: RecordsRepository = Depends(get_records_repo),
):
    existing = repo.get(user_id, record_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="釣果記録が見つかりません")

    changes = payload.model_dump(mode="json", exclude_unset=True)
    if not changes:
        return existing

    # マージ結果を作成時と同じバリデーションに通す（DECISIONS D-004）
    base_fields = {k: v for k, v in existing.items() if k in RecordCreate.model_fields}
    try:
        merged = RecordCreate.model_validate({**base_fields, **changes})
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=exc.errors(include_url=False, include_context=False),
        )

    updated = repo.update(user_id, record_id, merged.model_dump(mode="json"))
    if updated is None:
        raise HTTPException(status_code=404, detail="釣果記録が見つかりません")
    return updated


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(
    record_id: UUID,
    user_id: str = Depends(get_current_user_id),
    repo: RecordsRepository = Depends(get_records_repo),
):
    if not repo.delete(user_id, record_id):
        raise HTTPException(status_code=404, detail="釣果記録が見つかりません")
