"""FastAPI 依存関係（認証・DB・リポジトリ）。

認証（DECISIONS D-003）:
- Supabase の JWT 署名鍵は非対称鍵（ES256/RS256）へ移行済みのため、
  JWKS エンドポイント経由の検証を第一とする。
- レガシープロジェクト（HS256 + 共有シークレット）は SUPABASE_JWT_SECRET での
  検証にフォールバックする。
"""
from functools import lru_cache
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError

from app.config import get_settings
from app.repositories.fish import FishRepository
from app.repositories.records import RecordsRepository
from app.repositories.spots import SpotsRepository

_bearer = HTTPBearer(auto_error=False)

_JWKS_PATH = "/auth/v1/.well-known/jwks.json"
_AUDIENCE = "authenticated"


def get_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> str:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization ヘッダー（Bearer トークン）が必要です",
        )
    return credentials.credentials


@lru_cache
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_keys=True)


def _decode_token(token: str) -> dict:
    settings = get_settings()
    header = jwt.get_unverified_header(token)
    algorithm = header.get("alg", "")

    if algorithm in ("ES256", "RS256"):
        signing_key = _jwks_client(
            settings.supabase_url + _JWKS_PATH
        ).get_signing_key_from_jwt(token)
        return jwt.decode(
            token, signing_key.key, algorithms=[algorithm], audience=_AUDIENCE
        )

    if algorithm == "HS256":
        if not settings.supabase_jwt_secret:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="HS256 トークンですが SUPABASE_JWT_SECRET が未設定です",
            )
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience=_AUDIENCE,
        )

    raise jwt.InvalidTokenError(f"未対応のアルゴリズムです: {algorithm}")


def get_current_user_id(token: str = Depends(get_token)) -> str:
    """Supabase Auth の JWT を検証して user_id（sub）を返す。"""
    try:
        payload = _decode_token(token)
    except PyJWKClientError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="認証鍵（JWKS）の取得に失敗しました",
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
    """RLS を効かせた PostgREST クライアント（リクエスト毎に生成）。

    共有クライアントの Authorization ヘッダーを書き換える方式は
    並行リクエストで認証が混線しうるため、リクエストスコープで生成・破棄する。
    """
    from postgrest import SyncPostgrestClient

    settings = get_settings()
    client = SyncPostgrestClient(
        f"{settings.supabase_url}/rest/v1",
        headers={
            "apikey": settings.supabase_anon_key,
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        yield client
    finally:
        client.aclose()


def get_records_repo(db=Depends(get_db)) -> RecordsRepository:
    return RecordsRepository(db)


def get_spots_repo(db=Depends(get_db)) -> SpotsRepository:
    return SpotsRepository(db)


def get_fish_repo(db=Depends(get_db)) -> FishRepository:
    return FishRepository(db)
