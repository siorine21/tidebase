"""Supabase クライアント。

anon キーで生成し、リクエストごとにユーザー JWT を PostgREST へ渡して
RLS を効かせる（docs/DECISIONS.md D-003）。service_role キーは常用しない。
"""
from functools import lru_cache

from app.config import get_settings


@lru_cache
def get_client():
    from supabase import create_client

    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_anon_key)
