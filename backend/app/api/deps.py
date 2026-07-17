"""FastAPI 依存関係（認証・DB・リポジトリ）。"""
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.repositories.records import RecordsRepository
from app.repositories.spots import SpotsRepository

_bearer = HTTPBearer(auto_error=False)


def get_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> str:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization ヘッダー（Bearer トークン）が必要です",
        )
    return credentials.credentials


def get_current_user_id(token: str = Depends(get_token)) -> str:
    """Supabase Auth の JWT（HS256）を検証して user_id（sub）を返す。"""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="トークンが無効です"
        )
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="トークンに sub がありません"
        )
    return user_id


def get_db(token: str = Depends(get_token)):
    """ユーザー JWT を PostgREST に渡し、RLS を効かせたクライアントを返す。

    Lambda は 1 コンテナ 1 リクエストのため共有クライアントへの auth 設定で問題ない。
    """
    from app.db.client import get_client

    client = get_client()
    client.postgrest.auth(token)
    return client


def get_records_repo(db=Depends(get_db)) -> RecordsRepository:
    return RecordsRepository(db)


def get_spots_repo(db=Depends(get_db)) -> SpotsRepository:
    return SpotsRepository(db)
