# 🎣 TIDEBASE

釣行記録・ルアーレシピ管理・潮汐相関分析ができる個人向け Web アプリ。

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [docs/handoff/](docs/handoff/) | 開発ハンドオフ・確定仕様書 v2.4・ワイヤーフレーム v7.2 ほか |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 実装中の技術決定事項ログ |
| [docs/ops/委任運用ガイド_v1.0.md](docs/ops/委任運用ガイド_v1.0.md) | Claude Code への作業委任セットアップ（一度きり・15分） |
| [db/migrations/](db/migrations/) | DB スキーマ差分（`make db-migrate` で適用） |

## 技術スタック

- **バックエンド**: AWS Lambda (Python 3.12) + API Gateway + FastAPI + Mangum
- **DB**: Supabase (PostgreSQL + Auth + Storage)
- **フロント**: HTMX + Tailwind CSS + Vanilla JS（Phase 2〜）
- **IaC**: AWS SAM（`infrastructure/template.yaml`）

## セットアップ

```bash
make install                 # venv 作成 + 依存インストール
cp .env.example .env         # Supabase 接続情報を記入
make dev                     # http://localhost:8000/docs で SwaggerUI
make test                    # pytest
```

## API 概要（Phase 1）

| エンドポイント | 内容 |
|--------------|------|
| `POST /api/v1/records` ほか CRUD | 釣果記録（ボウズ記録・公開範囲対応） |
| `POST /api/v1/spots` ほか CRUD | スポット（水域区分・種別・⚠️干潮警告・観測点自動設定・削除ガード） |
| `POST /api/v1/spots/{id}/reassign` | 釣果スポット一括変更 |
| `GET /api/v1/spots/{id}/tide?date=` | スポットの最寄り観測点の潮汐 |
| `GET /api/v1/tide?station=TK&date=YYYY-MM-DD` | 潮汐データ（気象庁 潮位表・潮回り判定付き） |
| `GET /api/v1/fish-name/suggest?fish_species_id=&size_cm=` | 出世魚の呼称提案 |
| `GET /health` | ヘルスチェック |

> 潮汐観測点マスタ（`backend/app/data/jma_tide_stations.json`）は初期状態では東京（TK）のみ。
> ネットワークに出られる環境で `python3 scripts/generate_tide_stations.py > backend/app/data/jma_tide_stations.json`
> を実行して全地点に差し替えてください。

認証: `Authorization: Bearer <Supabase JWT>`（潮汐 API と `/health` は認証不要）。
