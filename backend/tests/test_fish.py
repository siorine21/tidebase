"""出世魚判定 API のテスト（確定仕様書 1.2 章の閾値）。"""
from uuid import uuid4

import pytest

BURI_ID = str(uuid4())
TROUT_ID = str(uuid4())
OTHER_USER_SPECIES_ID = str(uuid4())

BURI_RULES = [
    {"rule_group": "buri", "display_name": "ワカシ", "min_cm": None, "max_cm": 35, "region": "kanto", "sort_order": 1},
    {"rule_group": "buri", "display_name": "イナダ", "min_cm": 35, "max_cm": 60, "region": "kanto", "sort_order": 2},
    {"rule_group": "buri", "display_name": "ワラサ", "min_cm": 60, "max_cm": 80, "region": "kanto", "sort_order": 3},
    {"rule_group": "buri", "display_name": "ブリ", "min_cm": 80, "max_cm": None, "region": "kanto", "sort_order": 4},
]


@pytest.fixture(autouse=True)
def seed(fish_repo):
    fish_repo.species[BURI_ID] = {
        "id": BURI_ID, "user_id": None, "name": "ブリ", "name_rule_group": "buri",
    }
    fish_repo.species[TROUT_ID] = {
        "id": TROUT_ID, "user_id": None, "name": "トラウト", "name_rule_group": None,
    }
    fish_repo.species[OTHER_USER_SPECIES_ID] = {
        "id": OTHER_USER_SPECIES_ID, "user_id": str(uuid4()), "name": "アジ",
        "name_rule_group": None,
    }
    fish_repo.rules.extend(BURI_RULES)


def _suggest(client, species_id, size_cm):
    return client.get(
        "/api/v1/fish-name/suggest",
        params={"fish_species_id": species_id, "size_cm": size_cm},
    )


class TestSuggest:
    @pytest.mark.parametrize(
        ("size_cm", "expected"),
        [
            (20.0, "ワカシ"),
            (34.9, "ワカシ"),
            (35.0, "イナダ"),   # 境界は「以上」側（35cm〜60cm未満）
            (59.9, "イナダ"),
            (60.0, "ワラサ"),
            (80.0, "ブリ"),
            (120.0, "ブリ"),
        ],
    )
    def test_buri_thresholds(self, client, size_cm, expected):
        response = _suggest(client, BURI_ID, size_cm)
        assert response.status_code == 200
        body = response.json()
        assert body == {
            "suggested_name": expected,
            "rule_group": "buri",
            "matched": True,
        }

    def test_species_without_rule_group(self, client):
        response = _suggest(client, TROUT_ID, 30)
        assert response.status_code == 200
        assert response.json()["matched"] is False
        assert response.json()["suggested_name"] is None

    def test_missing_species_returns_404(self, client):
        assert _suggest(client, str(uuid4()), 30).status_code == 404

    def test_other_users_species_is_invisible(self, client):
        assert _suggest(client, OTHER_USER_SPECIES_ID, 30).status_code == 404

    def test_requires_auth(self, anon_client):
        response = anon_client.get(
            "/api/v1/fish-name/suggest",
            params={"fish_species_id": str(uuid4()), "size_cm": 30},
        )
        assert response.status_code == 401

    def test_invalid_size_is_rejected(self, client):
        assert _suggest(client, BURI_ID, -1).status_code == 422
