.PHONY: test db-test test-edge test-frontend db-migrate db-inspect

# ローカル/CI 共通テスト一式
test: db-test test-edge test-frontend

# マイグレーション + トリガー/RPC のテスト（要: PG* 環境変数で PostgreSQL に接続可能）
db-test:
	db/tests/run_local.sh

# Edge Function パーサーのテスト（要: tsc / node 22+）
test-edge:
	tsc supabase/functions/tide/parser.ts --outDir supabase/functions/tide/_build \
	  --target es2022 --module es2022 --moduleResolution bundler --strict
	node --test supabase/functions/tide/parser.test.mjs

# フロントの純粋関数のテスト（要: node 22+）
test-frontend:
	node frontend/tests/smooth_path.test.mjs

# 本番 Supabase への操作（要: SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF）
db-migrate:
	python3 scripts/supabase_admin.py apply

db-inspect:
	python3 scripts/supabase_admin.py inspect
