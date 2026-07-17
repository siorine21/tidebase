"""Supabase 自動停止防止 ping（Phase 0 手順書 Step 8）。"""
import os

import boto3
import httpx


def get_anon_key() -> str:
    ssm = boto3.client("ssm", region_name=os.getenv("AWS_REGION", "ap-northeast-1"))
    response = ssm.get_parameter(
        Name="/tidebase/dev/supabase_anon_key", WithDecryption=True
    )
    return response["Parameter"]["Value"]


def handler(event, context):
    """Supabase 自動停止防止 ping"""
    url = os.environ["SUPABASE_URL"] + "/rest/v1/"
    headers = {"apikey": get_anon_key()}
    try:
        res = httpx.get(url, headers=headers, timeout=10)
        print(f"Supabase ping: {res.status_code}")
        return {"status": res.status_code}
    except Exception as e:
        print(f"Supabase ping failed: {e}")
        raise
