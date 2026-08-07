"""Supabase Edge Function を Management API 経由でデプロイする。

SQL 適用（supabase_admin.py）と同じく、ダッシュボードでの手作業を無くして
Claude Code が自律的に反映できるようにする（docs/ops/委任運用ガイド.md）。

使い方:
    python3 scripts/deploy_function.py tide
    python3 scripts/deploy_function.py invite --no-verify-jwt
    python3 scripts/deploy_function.py --list

必要な環境変数:
    SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF

備考: このサンドボックスからの api.supabase.com へのアクセスは curl のみ通る
（Python の urllib は Cloudflare に 1010 で弾かれる）。そのため HTTP は
curl のサブプロセスで行う。
"""
import argparse
import json
import mimetypes
import os
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUNCTIONS_DIR = ROOT / "supabase" / "functions"
CONFIG_PATH = ROOT / "supabase" / "config.toml"
API = "https://api.supabase.com/v1"


def project_ref() -> str:
    ref = os.environ.get("SUPABASE_PROJECT_REF")
    if not ref:
        sys.exit("SUPABASE_PROJECT_REF が未設定です。")
    return ref


def token() -> str:
    value = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not value:
        sys.exit("SUPABASE_ACCESS_TOKEN が未設定です。")
    return value


def curl(args: list[str]) -> tuple[int, str]:
    """curl を実行し (HTTP ステータス, 本文) を返す。"""
    result = subprocess.run(
        ["curl", "-sS", "-w", "\n%{http_code}", "-H", f"Authorization: Bearer {token()}", *args],
        capture_output=True,
        text=True,
        check=True,
    )
    body, _, status = result.stdout.rpartition("\n")
    return int(status or 0), body


def verify_jwt_from_config(slug: str) -> bool:
    """supabase/config.toml の [functions.<slug>] を正とする。"""
    if not CONFIG_PATH.exists():
        return True
    config = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return bool(config.get("functions", {}).get(slug, {}).get("verify_jwt", True))


def source_files(slug: str) -> list[Path]:
    directory = FUNCTIONS_DIR / slug
    if not (directory / "index.ts").exists():
        sys.exit(f"{directory}/index.ts がありません。")
    # テストは Deno へ送らない（node --test 用で、Deno からは解決できない）
    return sorted(p for p in directory.glob("*.ts") if not p.name.endswith(".test.ts"))


def deploy(slug: str, verify_jwt: bool | None) -> None:
    files = source_files(slug)
    if verify_jwt is None:
        verify_jwt = verify_jwt_from_config(slug)

    metadata = {
        "name": slug,
        "entrypoint_path": "index.ts",
        "verify_jwt": verify_jwt,
        "static_patterns": [],
    }
    args = [
        "-X", "POST",
        f"{API}/projects/{project_ref()}/functions/deploy?slug={slug}",
        "-F", f"metadata={json.dumps(metadata)};type=application/json",
    ]
    for path in files:
        mime = mimetypes.guess_type(path.name)[0] or "text/plain"
        args += ["-F", f"file=@{path};filename={path.name};type={mime}"]

    status, body = curl(args)
    if status not in (200, 201):
        sys.exit(f"デプロイ失敗 ({status}): {body}")
    info = json.loads(body)
    print(f"deployed: {slug} version={info.get('version')} "
          f"verify_jwt={info.get('verify_jwt')} status={info.get('status')}")


def list_functions() -> None:
    status, body = curl([f"{API}/projects/{project_ref()}/functions"])
    if status != 200:
        sys.exit(f"一覧取得に失敗 ({status}): {body}")
    for fn in json.loads(body):
        print(f"{fn['slug']:12} v{fn['version']:<4} verify_jwt={str(fn['verify_jwt']):5} {fn['status']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug", nargs="?", help="supabase/functions/<slug>")
    parser.add_argument("--list", action="store_true", help="デプロイ済みの一覧")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--verify-jwt", dest="verify_jwt", action="store_true", default=None)
    group.add_argument("--no-verify-jwt", dest="verify_jwt", action="store_false")
    args = parser.parse_args()

    if args.list:
        list_functions()
        return
    if not args.slug:
        parser.error("slug か --list を指定してください。")
    deploy(args.slug, args.verify_jwt)


if __name__ == "__main__":
    main()
