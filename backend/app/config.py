"""アプリ設定。

優先順位: 環境変数 > SSM Parameter Store（Lambda 実行時のみ）。
機密情報は本番では SSM Parameter Store から取得する（ハンドオフ 8.3 章）。
"""
import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


def _running_in_lambda() -> bool:
    return bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME"))


def _ssm_parameter(name: str) -> str:
    import boto3  # Lambda ランタイムに同梱

    ssm = boto3.client("ssm", region_name=os.getenv("AWS_REGION", "ap-northeast-1"))
    response = ssm.get_parameter(Name=name, WithDecryption=True)
    return response["Parameter"]["Value"]


class Settings:
    def __init__(self) -> None:
        self.environment = os.getenv("ENVIRONMENT", "development")
        self.stage = os.getenv("STAGE", "dev")
        self.supabase_url = self._get("SUPABASE_URL", "supabase_url")
        self.supabase_anon_key = self._get("SUPABASE_ANON_KEY", "supabase_anon_key")
        self.supabase_jwt_secret = self._get("SUPABASE_JWT_SECRET", "supabase_jwt_secret")

    def _get(self, env_name: str, ssm_suffix: str) -> str:
        value = os.getenv(env_name, "")
        if not value and _running_in_lambda():
            value = _ssm_parameter(f"/tidebase/{self.stage}/{ssm_suffix}")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
