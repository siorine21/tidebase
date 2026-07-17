# 🏗️ TIDEBASE アーキテクチャ移行設計書 v1.0

> **2026-07-17 | AWS 撤去 → GitHub + Supabase 完結構成（D-021）**
>
> 本書は設計補完書 v1.0 のうちインフラ・API 層に関する記述を**置き換える**。
> ドメインロジック（バリデーション規則・潮汐仕様・出世魚閾値など）は従来どおり
> 確定仕様書 v2.4 + 設計補完書を正とする。

## 1. 新構成

```
[ブラウザ]
  ├─ 静的フロント（HTMX + Tailwind + supabase-js）
  │    └─ ホスティング: GitHub Pages（※要リポジトリ公開）or Cloudflare Pages【未決】
  ├─ データ CRUD → Supabase PostgREST（RLS + DB トリガーが整合性を保証）
  ├─ 出世魚判定 → PostgREST RPC /rest/v1/rpc/suggest_fish_name
  ├─ 認証 → Supabase Auth（supabase-js）
  ├─ 写真 → Supabase Storage（無料 1GB・クライアント側で圧縮）
  ├─ 天気・波高 → Open-Meteo を直接 fetch（CORS 対応・キー不要）
  └─ 潮汐 → Edge Function /functions/v1/tide（気象庁プロキシ・認証不要）

[GitHub Actions]
  ├─ CI: DB マイグレーションテスト（postgres サービス）+ Edge パーサーテスト
  ├─ keepalive: 毎日 JST 06:00 に Supabase へ ping（無料プラン停止防止）
  └─ Pages デプロイ（Phase 2、ホスティング先決定後）
```

- 月額コスト: **$0**（GitHub 無料枠 + Supabase 無料枠 + 公的/無料 API）
- 必要シークレット: **Supabase PAT 1 本**（Claude Code の運用用）+
  GitHub リポジトリ Secrets の `SUPABASE_URL` / `SUPABASE_ANON_KEY`（keepalive 用・anon は公開前提の値）

## 2. 旧 FastAPI エンドポイント → 新アクセスパターン対応表

| 旧（FastAPI） | 新 | 整合性の担保 |
|--------------|----|-------------|
| `POST /api/v1/records` | `supabase.from('fishing_records').insert({...})` | `trg_normalize_fishing_record`（ボウズ正規化・潮汐スナップショット自動付与） |
| `GET /api/v1/records?...` | `.select().eq('spot_id',..).gte('fished_at',..)` | RLS。日付境界は JST でクライアントが組む（D-011） |
| `PATCH /api/v1/records/{id}` | `.update({...}).eq('id', id)` | 同トリガー（fished_at 変更時の再計算含む） |
| `DELETE /api/v1/records/{id}` | `.delete().eq('id', id)` | RLS |
| `POST /api/v1/spots` | `.from('spots').insert({...})` | `trg_assign_tide_station`（観測点自動設定） |
| `DELETE /api/v1/spots/{id}` | `.delete().eq('id', id)` | `trg_guard_spot_delete` → 釣果紐付き時 **409**（件数はメッセージに含む） |
| `POST /api/v1/spots/{id}/reassign` | `.from('fishing_records').update({spot_id: to}).eq('spot_id', from)` | PostgREST の一括 UPDATE そのもの |
| `GET /api/v1/spots/{id}/tide` | spot の `tide_station_code` を読み → Edge Function 呼び出し | 淡水は code が NULL（フロントで潮汐タブ非表示） |
| `GET /api/v1/tide` | `GET /functions/v1/tide?station=TK&date=...` | Edge Function（認証不要・CORS 対応） |
| `GET /api/v1/fish-name/suggest` | `supabase.rpc('suggest_fish_name', {p_fish_species_id, p_size_cm})` | SECURITY INVOKER で RLS 有効 |

### エラーの読み替え（フロント実装時の規約）

| DB 側 | PostgREST レスポンス | UI での扱い |
|-------|--------------------|------------|
| ERRCODE 23514（ボウズ整合性違反 等） | 400 | 入力エラー表示 |
| ERRCODE 23503（スポット削除ガード・FK） | 409 | 一括変更画面へ誘導（確定仕様書 17.2 章） |
| ERRCODE P0002（魚種なし） | 400 | 「魚種が見つかりません」 |
| RLS による不可視 | 空結果 / 404 | 対象なしとして扱う |

## 3. DB へ移植したロジック（004_schema_v1.4_delta.sql）

| 関数・トリガー | 旧実装 | テスト |
|--------------|--------|--------|
| `moon_age()` / `tide_type()` / `auto_tide_snapshot()` | app/services/tide.py | `db/tests/test_migrations.sql` + TS 版とのパリティテスト |
| `trg_normalize_fishing_record` | RecordCreate バリデーション + D-012 | 同上 |
| `nearest_tide_station()` / `trg_assign_tide_station` | app/services/tide_stations.py | 同上 |
| `trg_guard_spot_delete` | delete_spot の 409 ガード | 同上 |
| `suggest_fish_name()` RPC | app/api/fish.py | 同上（境界値含む） |

- **丸めの正**: 月齢の丸めは**四捨五入**（D-002 の記載どおり）。旧 Python 実装は
  銀行丸めで .5 境界のみ挙動が異なっていたが、SQL / TypeScript 実装を正とする
  （730 日間の突合で差異は .5 境界の 18 日のみ、いずれも隣接潮回りへのずれ）
- テストは合成 v1.1 ベースライン（`db/tests/baseline_v1.1_synthetic.sql`）上で
  002→003→004 を通しで適用して実行。**実 DB との突合（`make db-inspect`）は別途必須**

## 4. Edge Function（supabase/functions/tide/）

- `parser.ts`: 気象庁フォーマットのパース + 月齢・潮回り（純粋ロジック、node:test でテスト）
- `index.ts`: `GET ?station=XX&date=YYYY-MM-DD`。新旧 URL フォールバック・
  年間テキストをインスタンス内キャッシュ（24h）・CORS 許可・`verify_jwt = false`
- デプロイ: `SUPABASE_ACCESS_TOKEN` で Management API / supabase CLI から実行
  （委任セットアップ完了後に Claude Code が実施）

## 5. 観測点マスタの運用

- 実体は `public.tide_stations` テーブル（seed は東京 TK のみ）
- 全地点投入: `python3 scripts/generate_tide_stations.py > db/seeds/tide_stations.sql`
  → `supabase_admin.py sql` で適用 → 既存スポットの再計算 UPDATE（スクリプト内に記載）

## 6. AWS 資産の後片付け（ユーザー作業・任意のタイミングで可）

放置してもほぼ $0 だが、以下で完全撤去できる（マネコンまたは CLI）:

```bash
aws cloudformation delete-stack --stack-name tidebase-dev --profile yuki   # ping Lambda ほか
aws s3 rb s3://tidebase-media-dev --force --profile yuki
aws s3 rb s3://tidebase-frontend-dev --force --profile yuki
aws ssm delete-parameters --names /tidebase/dev/supabase_url \
  /tidebase/dev/supabase_anon_key /tidebase/dev/supabase_service_key --profile yuki
# 最後に IAM ユーザー yuki のアクセスキーを無効化（もう使わない）
```

Route 53 は D-010 で不使用済み。ドメイン `tidebase.app` を取得済みなら
ホストゾーン削除 + 更新停止の判断のみ。

## 7. 残タスク

| # | タスク | 担当 | 前提 |
|---|--------|------|------|
| 1 | フロントのホスティング先決定（リポジトリ公開 → GitHub Pages / 非公開のまま → Cloudflare Pages） | ユーザー判断 | — |
| 2 | 実 DB スキーマ突合 + マイグレーション適用 | Claude Code | 委任セットアップ |
| 3 | 観測点マスタ全地点投入 | Claude Code | 同上（jma.go.jp 許可） |
| 4 | Edge Function デプロイ + 気象庁実疎通確認 | Claude Code | 同上 |
| 5 | GitHub Secrets（keepalive 用）の登録 | ユーザー（2 分） | — |
| 6 | Supabase Auth 設定 + SCR-001/010 を含むフロント実装開始 | Claude Code | 1 の決定 |
| 7 | AWS 資産の後片付け（6 章） | ユーザー（任意） | — |

---

*TIDEBASE アーキテクチャ移行設計書 v1.0 — 2026-07-17*
