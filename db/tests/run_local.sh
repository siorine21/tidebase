#!/usr/bin/env bash
# マイグレーション + トリガー/RPC のローカルテスト
# 前提: PostgreSQL に PG* 環境変数（PGHOST/PGPORT/PGUSER）で接続できること
# CI では postgres サービスコンテナに対して実行する
set -euo pipefail

cd "$(dirname "$0")/../.."

DB_NAME="${TIDEBASE_TEST_DB:-tidebase_migration_test}"

dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q -f db/tests/baseline_v1.1_actual.sql
for migration in db/migrations/*.sql; do
  echo "applying: $migration"
  psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q -f "$migration"
done

psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q -f db/tests/test_migrations.sql
echo "OK: db tests passed"
