# 🎣 TIDEBASE

釣行記録・ルアーレシピ管理・潮汐相関分析ができる個人向け Web アプリ。

## 構成（GitHub + Supabase 完結・月額 $0）

- **DB / 認証 / ストレージ / API**: Supabase(PostgreSQL + PostgREST + Auth + Storage)
  — 整合性はすべて DB 側(RLS + トリガー + RPC)で担保
- **潮汐**: Edge Function(`supabase/functions/tide/`)が気象庁 潮位表をプロキシ
- **天気・波高**: Open-Meteo をブラウザから直接取得(API キー不要)
- **フロント**: HTMX + Tailwind + supabase-js(Phase 2〜)。GitHub Pages / Cloudflare Pages
- **CI / keepalive**: GitHub Actions

> 旧 AWS 構成(Lambda + FastAPI)からの移行内容は
> [docs/design/TIDEBASE_アーキテクチャ移行_v1.0.md](docs/design/TIDEBASE_アーキテクチャ移行_v1.0.md) を参照(D-021)。

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [docs/handoff/](docs/handoff/) | 開発ハンドオフ・確定仕様書 v2.4・ワイヤーフレーム v7.2 ほか |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 技術決定事項ログ(D-001〜D-021) |
| [docs/design/](docs/design/) | 設計補完書・アーキテクチャ移行設計書 |
| [docs/ops/委任運用ガイド_v1.0.md](docs/ops/委任運用ガイド_v1.0.md) | Claude Code への作業委任セットアップ |
| [db/migrations/](db/migrations/) | DB スキーマ差分(`make db-migrate` で適用) |

## 開発

```bash
make test        # DB テスト + Edge パーサーテスト(CI と同一)
make db-test     # マイグレーション + トリガー/RPC テスト(要: ローカル PostgreSQL)
make test-edge   # 潮汐パーサーテスト(要: node 22+ / tsc)
make db-migrate  # 本番 Supabase へ適用(要: SUPABASE_ACCESS_TOKEN / PROJECT_REF)
make db-inspect  # 本番スキーマの実態表示
```

## データアクセス(フロント実装時の規約)

| 操作 | 方法 |
|------|------|
| 釣果・スポット・レシピ CRUD | supabase-js → PostgREST(RLS + トリガー) |
| 出世魚判定 | `supabase.rpc('suggest_fish_name', {p_fish_species_id, p_size_cm})` |
| 潮汐 | `GET {SUPABASE_URL}/functions/v1/tide?station=TK&date=YYYY-MM-DD`(認証不要) |
| 天気・波高 | Open-Meteo Forecast / Marine API を直接 fetch |
| 写真 | Supabase Storage(クライアント側圧縮・5MB 上限) |

> 潮汐観測点マスタ(`tide_stations`)の seed は東京(TK)のみ。全地点は
> `python3 scripts/generate_tide_stations.py > db/seeds/tide_stations.sql` で生成して投入する。
