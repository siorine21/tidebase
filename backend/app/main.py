"""TIDEBASE API エントリポイント（FastAPI + Mangum）。"""
from fastapi import FastAPI
from mangum import Mangum

from app.api import records, spots, tide

app = FastAPI(
    title="TIDEBASE API",
    description="Your Fishing Knowledge Base",
    version="0.2.0",
)

app.include_router(records.router)
app.include_router(spots.router)
app.include_router(tide.router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "TIDEBASE"}


# Lambda ハンドラー
handler = Mangum(app)
