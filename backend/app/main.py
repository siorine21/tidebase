"""TIDEBASE API エントリポイント（FastAPI + Mangum）。"""
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from mangum import Mangum
from postgrest.exceptions import APIError

from app.api import records, spots, tide

app = FastAPI(
    title="TIDEBASE API",
    description="Your Fishing Knowledge Base",
    version="0.2.0",
)

app.include_router(records.router)
app.include_router(spots.router)
app.include_router(tide.router)


# PostgREST（Supabase）エラーの HTTP マッピング。
# 生の 500 + スタックトレースを返さないための防波堤。
_PG_ERROR_MAP = {
    "23503": (422, "参照先のデータが存在しません"),          # FK 違反
    "23505": (409, "同じデータが既に存在します"),            # 一意制約違反
    "23514": (422, "入力値が制約に違反しています"),          # CHECK 違反
    "42501": (403, "この操作を行う権限がありません"),        # RLS / 権限
    "PGRST116": (404, "対象のデータが見つかりません"),
    "PGRST301": (401, "認証情報が無効です"),
}


@app.exception_handler(APIError)
async def postgrest_error_handler(request: Request, exc: APIError):
    error = exc.json()
    code = str(error.get("code") or "")
    status_code, message = _PG_ERROR_MAP.get(code, (500, "データベース処理に失敗しました"))
    return JSONResponse(
        status_code=status_code,
        content={"detail": {"message": message, "code": code}},
    )


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "TIDEBASE"}


# Lambda ハンドラー
handler = Mangum(app)
