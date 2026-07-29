"""Supabase Management API 経由の DB 運用スクリプト。

SQL Editor での手動作業を無くし、Claude Code がマイグレーション適用と
スキーマ確認を自律的に行えるようにする（docs/ops/委任運用ガイド.md）。

使い方:
    python3 scripts/supabase_admin.py apply              # 未適用の migration を順に適用
    python3 scripts/supabase_admin.py apply --dry-run    # 適用対象の表示のみ
    python3 scripts/supabase_admin.py inspect            # public スキーマの実態を表示
    python3 scripts/supabase_admin.py sql "SELECT 1"     # 任意 SQL の実行

必要な環境変数:
    SUPABASE_ACCESS_TOKEN  … Personal Access Token（supabase.com → Account → Access Tokens）
    SUPABASE_PROJECT_REF   … プロジェクト参照 ID（ダッシュボード URL の英数字部分）
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.supabase.com/v1/projects/{ref}/database/query"
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "db" / "migrations"

# 適用履歴は運用専用。PostgREST（anon / authenticated）から触れないよう
# 権限を剥奪し、RLS もポリシーなしで有効化する（多層防御）
MIGRATIONS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS public._migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
REVOKE ALL ON public._migrations FROM anon, authenticated;
ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;
"""


def project_ref() -> str:
    """プロジェクト参照 ID。未設定・不正な場合は SUPABASE_URL から導出する。

    参照 ID は 20 文字の英小文字。API キー（sb_... / sbp_...）が誤って
    設定されていても URL 側から復旧できるようにする。
    """
    ref = os.environ.get("SUPABASE_PROJECT_REF", "").strip()
    if re.fullmatch(r"[a-z]{20}", ref):
        return ref

    url = os.environ.get("SUPABASE_URL", "").strip()
    match = re.match(r"https://([a-z]{20})\.supabase\.co", url)
    if match:
        return match.group(1)

    sys.exit("SUPABASE_PROJECT_REF（または SUPABASE_URL）を正しく設定してください")


def run_sql(query: str):
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    ref = project_ref()
    if not token:
        sys.exit("SUPABASE_ACCESS_TOKEN を設定してください")

    request = urllib.request.Request(
        API_URL.format(ref=ref),
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # 既定の python-urllib UA は Cloudflare にブロックされる（error 1010）
            "User-Agent": "tidebase-admin/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        sys.exit(f"Management API エラー {error.code}: {detail}")
    return json.loads(body) if body else []


def cmd_apply(dry_run: bool) -> None:
    run_sql(MIGRATIONS_TABLE_DDL)
    applied = {row["name"] for row in run_sql("SELECT name FROM public._migrations;")}

    pending = [
        path
        for path in sorted(MIGRATIONS_DIR.glob("*.sql"))
        if path.name not in applied
    ]
    if not pending:
        print("適用対象なし（すべて適用済み）")
        return

    for path in pending:
        if dry_run:
            print(f"[dry-run] {path.name}")
            continue
        print(f"適用中: {path.name} ...", flush=True)
        run_sql(path.read_text(encoding="utf-8"))
        run_sql(
            f"INSERT INTO public._migrations (name) VALUES ('{path.name}') "
            "ON CONFLICT (name) DO NOTHING;"
        )
        print(f"  → 完了")


def cmd_inspect() -> None:
    print("== テーブル / ビュー と RLS ==")
    rows = run_sql(
        """
        SELECT c.relname AS name,
               CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' END AS kind,
               c.relrowsecurity AS rls
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
        ORDER BY c.relname;
        """
    )
    for row in rows:
        rls = "RLS✅" if row["rls"] else ("RLS❌" if row["kind"] == "table" else "-")
        print(f"  {row['name']:<24} {row['kind']:<6} {rls}")

    print("\n== カラム一覧 ==")
    rows = run_sql(
        """
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position;
        """
    )
    current = None
    for row in rows:
        if row["table_name"] != current:
            current = row["table_name"]
            print(f"  [{current}]")
        nullable = "NULL可" if row["is_nullable"] == "YES" else "NOT NULL"
        print(f"    {row['column_name']:<22} {row['data_type']:<26} {nullable}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    apply_parser = sub.add_parser("apply", help="未適用 migration の適用")
    apply_parser.add_argument("--dry-run", action="store_true")
    sub.add_parser("inspect", help="スキーマ実態の表示（v1.1 突合用）")
    sql_parser = sub.add_parser("sql", help="任意 SQL の実行")
    sql_parser.add_argument("query")
    args = parser.parse_args()

    if args.command == "apply":
        cmd_apply(args.dry_run)
    elif args.command == "inspect":
        cmd_inspect()
    else:
        print(json.dumps(run_sql(args.query), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
