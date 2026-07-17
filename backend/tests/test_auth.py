"""認証（JWT 検証）のテスト。

- ES256（新方式・JWKS）: JWKS クライアントを差し替えて検証パスを通す
- HS256（レガシー・共有シークレット）: フォールバックとして検証
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.api import deps
from app.config import get_settings
from app.main import app

USER_ID = "11111111-1111-1111-1111-111111111111"
HS_SECRET = "test-secret-0123456789abcdef0123456789abcdef"


def _claims(**overrides):
    claims = {
        "sub": USER_ID,
        "aud": "authenticated",
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    claims.update(overrides)
    return claims


@pytest.fixture
def auth_client(records_repo, monkeypatch):
    """認証依存は本物のまま、リポジトリだけ差し替えたクライアント。"""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", HS_SECRET)
    get_settings.cache_clear()
    app.dependency_overrides[deps.get_records_repo] = lambda: records_repo
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
    get_settings.cache_clear()


class TestHS256:
    def _token(self, secret=HS_SECRET, **overrides):
        return pyjwt.encode(_claims(**overrides), secret, algorithm="HS256")

    def test_valid_token(self, auth_client):
        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {self._token()}"}
        )
        assert response.status_code == 200

    def test_wrong_secret_is_rejected(self, auth_client):
        token = self._token(secret="wrong-secret-0123456789abcdef0123456789")
        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401

    def test_wrong_audience_is_rejected(self, auth_client):
        token = self._token(aud="anon")
        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401

    def test_expired_token_is_rejected(self, auth_client):
        token = self._token(exp=datetime.now(timezone.utc) - timedelta(minutes=1))
        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401

    def test_missing_header_is_rejected(self, auth_client):
        assert auth_client.get("/api/v1/records").status_code == 401


class TestES256:
    def test_valid_token_via_jwks(self, auth_client, monkeypatch):
        private_key = ec.generate_private_key(ec.SECP256R1())
        token = pyjwt.encode(
            _claims(), private_key, algorithm="ES256", headers={"kid": "test-key"}
        )
        fake_jwks = SimpleNamespace(
            get_signing_key_from_jwt=lambda _token: SimpleNamespace(
                key=private_key.public_key()
            )
        )
        monkeypatch.setattr(deps, "_jwks_client", lambda url: fake_jwks)

        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200

    def test_token_signed_by_other_key_is_rejected(self, auth_client, monkeypatch):
        signer = ec.generate_private_key(ec.SECP256R1())
        other = ec.generate_private_key(ec.SECP256R1())
        token = pyjwt.encode(
            _claims(), signer, algorithm="ES256", headers={"kid": "test-key"}
        )
        fake_jwks = SimpleNamespace(
            get_signing_key_from_jwt=lambda _token: SimpleNamespace(
                key=other.public_key()
            )
        )
        monkeypatch.setattr(deps, "_jwks_client", lambda url: fake_jwks)

        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401


class TestUnsupportedAlgorithm:
    def test_none_algorithm_is_rejected(self, auth_client):
        token = pyjwt.encode(_claims(), key=None, algorithm="none")
        response = auth_client.get(
            "/api/v1/records", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401
