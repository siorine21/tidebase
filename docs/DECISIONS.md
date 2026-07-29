# TIDEBASE 開発決定事項（DECISIONS）

> 実装中に下した技術判断のログ。仕様レベルの確定事項は
> `docs/handoff/TIDEBASE_確定仕様書_v2.4.md` を正とする。
> 判断基準（ハンドオフ 9.2 章）：コスト最小 > 無料枠内 > 確定仕様書に従う。

## 決定一覧

### D-001: 潮汐データソースは気象庁「潮位表」テキストデータ（2026-07-17）

- **決定**: 潮汐データ PoC のソースは気象庁の潮位表（推算値）テキスト
  `https://www.data.jma.go.jp/gmd/kaiyou/data/db/tide/suisan/txt/{year}/{station}.txt` を使用する。
- **理由**: 完全無料・API キー不要・国内観測点網羅。月額 $7 上限の制約下で
  有料 API（WorldTides 等）を避ける。年単位ファイルなので観測点×年でキャッシュすれば
  リクエスト数も最小。
- **備考**: 固定長フォーマット（毎時潮位 24×3 桁 + 年月日 + 地点記号 + 満潮4回 + 干潮4回）を
  `backend/app/services/tide.py` でパースする。開発サンドボックスからは外部ネットワーク
  ポリシーにより実データ取得が未検証（フォーマット仕様準拠 + フィクスチャでテスト済み）。
  実環境での疎通確認が Phase 1 の残タスク。

### D-002: 潮回り（大潮・中潮…）は月齢近似で判定（2026-07-17）

- **決定**: 潮回り判定は月齢（朔からの経過日数）を四捨五入した値のマッピングで行う。
  - 大潮: 0-2, 14-17, 29 / 中潮: 3-6, 12-13, 18-21, 27-28 / 小潮: 7-9, 22-24 /
    長潮: 10, 25 / 若潮: 11, 26
- **理由**: PoC として十分な精度で、外部依存ゼロ・計算コストゼロ。
- **備考**: 厳密には潮回りは朔望ベース。精度が問題になった場合に見直す。

### D-003: API 認証は Supabase JWT を FastAPI 依存で検証し、DB は RLS 前提でアクセス（2026-07-17 / 改訂 2026-07-17）

- **決定**: `Authorization: Bearer <Supabase JWT>` を PyJWT で検証（aud=authenticated）。
  - **第一**: JWKS エンドポイント（`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`）
    経由で ES256 / RS256 を検証（Supabase の JWT 署名鍵移行後の標準）。
  - **フォールバック**: レガシープロジェクト向けに HS256 + `SUPABASE_JWT_SECRET`。
  - DB アクセスはリクエストごとに PostgREST クライアントを生成し、
    anon キー + ユーザー JWT で RLS を効かせる（共有クライアントのヘッダー
    書き換え方式は並行リクエストで認証が混線しうるため廃止）。
- **理由**: service_role キーの常用は RLS バイパスとなり事故リスクが高い
  （ハンドオフ 8.1 章「RLS を必ず有効化」）。Supabase 公式も共有シークレットでの
  検証を非推奨としており、新規プロジェクトのデフォルト署名は ES256。
  多層防御としてクエリ側でも `user_id = auth.uid()` 相当のフィルタを常に付ける。
- **備考**: supabase-py への依存を外し、postgrest + PyJWT[crypto] の直接利用に変更
  （Lambda パッケージも軽量化）。Supabase ダッシュボード → JWT Keys で
  プロジェクトの鍵タイプを確認すること。

### D-004: 釣果 API の部分更新は PATCH、更新時も作成時と同じ整合性検証を通す（2026-07-17）

- **決定**: `PATCH /api/v1/records/{id}` で部分更新。既存レコードとマージした結果を
  作成時と同じバリデーション（ボウズ時 `catch_count=0` 強制等）に通す。
- **理由**: 「ボウズなのに匹数 3」のような不整合をどの経路からも作らせないため。

### D-005: enum の内部値（2026-07-17）

- **決定**:
  - ヒットレンジ: `surface`（表層）/ `middle`（中層）/ `bottom`（底層）/ `bottom_direct`（ボトム直撃）
  - 水域区分: `saltwater` / `brackish` / `freshwater`（確定仕様書 14 章のとおり）
  - 公開範囲: `group`（デフォルト）/ `private`（確定仕様書 5 章のとおり）
  - 潮回り: `大潮` / `中潮` / `小潮` / `長潮` / `若潮`（表示値をそのまま API 値とする）

### D-006: スポット削除は釣果紐付き時 409 + 一括変更エンドポイント（2026-07-17）

- **決定**: `DELETE /api/v1/spots/{id}` は紐付く釣果が 1 件以上なら 409 を返し、
  レスポンスに件数を含める。`POST /api/v1/spots/{id}/reassign` で釣果の
  スポット一括変更（全件 or 指定 ID のみ）を行ってから削除する。
- **理由**: 確定仕様書 17 章のフロー（削除前に一括変更へ誘導）を API レベルで担保。

### D-007: DB スキーマ v1.2 差分は SQL ファイルで管理し Supabase SQL Editor で手動適用（2026-07-17）

- **決定**: ハンドオフ 2 章の追加・修正を `db/migrations/002_schema_v1.2_delta.sql` に集約。
  適用は Supabase SQL Editor で手動実行（v1.1 適用済み DB への差分）。
- **備考**: `group_members` の RLS は自己参照による無限再帰を避けるため
  SECURITY DEFINER 関数 `is_group_member()` を経由する。

### D-008: リポジトリ／ブランチ運用（2026-07-17）

- **決定**: 本セッションでは GitHub リポジトリ `siorine21/tidebase` の
  指定ブランチ `claude/phase-1-implementation-a97h2a` で開発する。
- **備考**: ハンドオフ 8.2 章は CodeCommit / `master` を前提としているが、
  実リポジトリの指示（GitHub）を優先。コミットメッセージは日本語・簡潔の規約を踏襲。

### D-009: 潮汐 API は認証不要の公開エンドポイント（2026-07-17）

- **決定**: `GET /api/v1/tide` はユーザーデータを含まない公的データのため認証不要とする。
- **備考**: 悪用（大量リクエスト）対策は API Gateway スロットリング（デフォルト）に委ねる。
  必要になれば認証必須に変更する。

### D-010: 当面はカスタムドメインなしで運用（2026-07-17）

- **決定**: `tidebase.app` ドメインと Route 53 ホストゾーンは当面使わず、
  CloudFront デフォルトドメイン（`dxxxx.cloudfront.net`）+ API Gateway
  デフォルト URL で運用する。ユーザー 1 人の想定で月額コストはほぼ $0 になる。
- **理由**: 固定費（ホストゾーン $0.50/月 + `.app` 更新 約 $14/年）が
  現構成の月額コストのほぼ全額を占めるため（コスト最小化の判断基準に従う）。
- **影響と備考**:
  - HTTPS は CloudFront デフォルト証明書でそのまま有効。ACM・Route 53 は不要。
  - Supabase Auth の Site URL / リダイレクト URL には CloudFront ドメインを設定する
    （将来ドメイン導入時に要更新）。
  - グループ招待 URL（Phase 4、確定仕様書 4.1 章の `https://tidebase.app/join?...`）は
    CloudFront ドメインベースに読み替える。トークンは 7 日で失効するため、
    将来のドメイン切替でリンクが無効化しても影響は軽微。
  - フロント配信と API は同一 CloudFront ディストリビューションに載せる
    （`/api/*` ビヘイビア → API Gateway オリジン）。単一オリジンになるため
    CORS 問題（レビュー指摘 8）自体が消える。Phase 2 のインフラ構成で採用する。
  - 後からドメインを導入する場合も、ACM 証明書 + CloudFront の代替ドメイン名 +
    DNS 追加のみで既存構成の作り直しは発生しない。
  - `tidebase.app` を既に取得済みの場合: ホストゾーンだけ削除すれば $0.50/月 は
    即座に節約できる。ドメイン自体は次回更新時に継続可否を判断すればよい。

### D-011: 日付境界はすべて JST 基準（2026-07-17）

- **決定**: 釣果の日付フィルタ（`date_from` / `date_to`）と「1日1釣行」の日付集計は
  `Asia/Tokyo`（+09:00）基準とする。naive な日時入力は JST とみなす。
- **理由**: `fished_at` は timestamptz（UTC 保存）のため、素の `DATE()` 比較だと
  JST 深夜 0〜9 時の釣行が前日扱いになり、潮汐相関の釣行回数がずれる。
- **備考**: v1.1 の `tide_correlation` ビューが `DATE(fished_at)` を使っている場合、
  `DATE(fished_at AT TIME ZONE 'Asia/Tokyo')` への修正が必要（v1.1 SQL 入手後に確認）。

### D-012: 釣果作成時に潮汐スナップショットをサーバー側で自動付与（2026-07-17）

- **決定**: `POST /api/v1/records` で `tide_snapshot` 未指定の場合、
  fished_at（JST 日付）から `{tide_type, moon_age, method: "moon_age_approx"}` を
  自動生成して保存する。クライアントが明示指定した場合はそちらを優先。
  `fished_at` の更新時、自動付与分（method で判別）は再計算する。
- **理由**: 潮汐相関分析（確定仕様書 13 章）の集計元となる潮回りデータを
  登録時点で確定保存するため（F-01 STEP5「潮汐・天気は自動取得して保存」）。
  月齢ベースなので観測点マッピング（未設計）に依存せず Phase 1 で成立する。
- **備考**: 将来、最寄り観測点の潮位（JMA）や天気（Open-Meteo 予定）を
  スナップショットに追加する際も `method` キーで世代を区別できる。

> 以下 D-013〜D-019 の詳細設計は `docs/design/TIDEBASE_設計補完_v1.0.md` を参照。

### D-013: 天気・波高データソースは Open-Meteo（2026-07-17）

- **決定**: OpenWeatherMap（確定仕様書 3 章）を Open-Meteo に置換。
  天気/風は Forecast API、波高は Marine API、過去釣行は Historical API。
- **理由**: OWM 無料プランに波高データが存在せず US-204 が実現不能。
  Open-Meteo は無料・API キー不要（キー管理も消える）。設計補完書 1〜2 章。

### D-014: スポット拡張フィールドの裁定（2026-07-17）

- **決定**: 確定仕様書 15.3（最小）と要件定義書 2.3（リッチ）の矛盾を裁定。
  Phase 1 で `spot_type` / `low_tide_only`（US-201 警告）/ `visibility` /
  `tide_station_code` を追加、残り（水深・底質・メモ類・対象魚種）は Phase 2。
  `spot_type` と `water_type` は独立。設計補完書 4 章。

### D-015: 出世魚判定は fish_name_rules マスタ + 提案 API（2026-07-17）

- **決定**: システムマスタ `fish_name_rules`（rule_group: buri/suzuki/sawara、関東呼称）
  と `GET /api/v1/fish-name/suggest` で実装。提案のみで強制しない。
  採用呼称は `fishing_records.fish_display_name` に保存し、`fish_species_id` は
  親魚種のまま（集計は親魚種・表示は呼称）。設計補完書 5 章。

### D-016: 写真は S3 署名付き URL 直アップロード方式（2026-07-17）

- **決定**: presign 発行 API → クライアント直 PUT → `photo_key` 保存 →
  取得時に署名付き GET URL を動的生成。バケット非公開・5MB 上限・
  キーは `photos/{user_id}/{uuid}`。設計補完書 6 章。

### D-017: 最寄り潮汐観測点は静的マスタ + 最近傍自動設定（2026-07-17）

- **決定**: 気象庁観測点マスタをリポジトリ内 JSON で保持し、スポット作成・
  座標更新時にハバーサイン距離で `tide_station_code` を自動設定（淡水は NULL）。
  潮汐 API は `spot_id` 指定も受け付ける。設計補完書 3 章。

### D-018: 釣行スコアの決定的アルゴリズム（2026-07-17）

- **決定**: 悪条件（嵐→雨/強風）から順に評価し、若潮・長潮はスコア 3 グループに
  含める。天気区分は Open-Meteo の WMO weather_code からマッピング。
  設計補完書 7 章。

### D-019: CI は GitHub Actions で pytest のみ、デプロイは当面手動（2026-07-17）

- **決定**: push/PR で pytest を実行するワークフローを追加。`sam deploy` の
  自動化（OIDC）は Phase 5 で検討。設計補完書 9 章。
- **備考**: API Gateway オーソライザーは採用しない（FastAPI 依存での JWT 検証に
  一本化。オーソライザー Lambda はコールドスタート二段化のデメリットのみ）。

### D-020: 構築・運用作業を Claude Code へ委任する体制（2026-07-17）

- **決定**: ユーザー作業を「一度きりの環境セットアップ（ネットワーク許可 +
  シークレット登録）と PR 承認」に最小化する。DB マイグレーション適用・
  スキーマ確認は Supabase Management API 経由のスクリプト
  （`scripts/supabase_admin.py`、適用済み管理テーブル `_migrations` で冪等）で
  Claude Code が実行する。手順は `docs/ops/委任運用ガイド_v1.0.md`。
- **理由**: SQL Editor での手動適用は作業負荷とヒューマンエラーの温床。
  Management API は HTTPS のみで完結し、サンドボックスのプロキシ経由でも動作する
  （Postgres 5432 直結はプロキシを通らないため不採用）。

### D-021: AWS 全面撤去 — GitHub + Supabase 完結構成へ移行（2026-07-17）

- **決定**: Lambda / API Gateway / S3 / CloudFront / SSM / EventBridge を廃止。
  - API: PostgREST 直接アクセス + DB トリガー/RPC（FastAPI 層は撤去、git 履歴に残存）
  - 潮汐のみ Edge Function（`supabase/functions/tide/`、気象庁プロキシ）
  - 写真: Supabase Storage / フロント: GitHub Pages or Cloudflare Pages（未決）
  - keepalive・CI: GitHub Actions（旧 EventBridge ping の置き換え含む）
- **理由**: シークレット最小化（AWS キーを渡す必要が消滅）・層削減・月額 $0 維持。
  詳細は `docs/design/TIDEBASE_アーキテクチャ移行_v1.0.md`。
- **備考**:
  - ドメインロジックは DB へ移植し、合成 v1.1 ベースライン上の SQL テストで検証
    （CI でも postgres サービスで毎回実行）
  - 月齢の丸めは四捨五入を正とする（D-002 どおり。旧 Python 実装は銀行丸めで
    .5 境界のみ相違、SQL/TS 実装で統一）
  - D-003 の JWT 検証層・D-016 の presign API・D-019 の pytest CI は本決定により失効
    （認証は supabase-js + RLS、写真は Storage SDK、CI は SQL/TS テストに置換）

### D-022: フロントは GitHub Pages・リポジトリは public 化（2026-07-18）

- **決定**: リポジトリを public にし、フロントは GitHub Pages（Actions デプロイ）で
  ホスティングする。
- **セキュリティ評価**（public 化の前提確認・2026-07-18 実施）:
  - 全コミット履歴をスキャンし、シークレット（AWS キー・JWT・PAT 等のパターン）の
    混入ゼロを確認済み
  - anon キーは将来フロントコードに含まれるが公開前提の値（防壁は RLS）
  - 釣果・スポット座標等の個人データは DB 側にありリポジトリに含まれない
  - セキュリティは「コードの秘匿」に依存しない設計（RLS・トリガーは公開されても安全）
- **運用**: public 化にあわせて GitHub の Secret scanning + Push protection を有効化し、
  以後の誤コミットを入口で遮断する。

### D-023: 実 v1.1 スキーマとの突合結果を正とする（2026-07-18）

- **背景**: 本番 DB を初めて直接確認した結果、想定台帳（設計補完書 8 章）と
  複数のカラムが食い違っていた。全テーブル 0 行だったため、既存カラムに
  合わせる方向で調整した（データ移行は不要）。
- **決定（実カラムを採用し、重複する追加は取りやめ）**:

  | 想定していた名前 | 実際に採用 | 備考 |
  |----------------|-----------|------|
  | `size_cm` | **`length_cm`** | 併せて `weight_g`（仕様 3 章の重量）も既存 |
  | `hit_range` | **`water_layer`** | ヒットレンジ |
  | `fish_display_name` | **`fish_name_local`** | 出世魚の採用呼称 |
  | `photo_key` | **`photo_url`** | Supabase Storage のパスを格納 |
  | `rod/reel/line/leader` | 既存のまま | v1.1 で既に存在 |

- **`fished_at` は DATE 型**（timestamptz ではない）。「1日1釣行」の単位と一致し、
  タイムゾーン境界問題が発生しないため DATE を維持する（**D-011 は釣果に関しては不要になった**）。
  時刻（朝マズメ等）の記録が必要になった場合は Phase 2 で `fished_time` を追加検討。
- **潮回りは `tide_type` カラムが正**。`tide_correlation` ビュー（確定仕様書 14.3 章の
  集計を実装済み）が参照しているため。`tide_snapshot`（JSONB）は月齢・算出方式などの
  詳細を保持し、トリガーが両者を整合させる。
- **追加したカラム**（v1.1 に不足していたもの）: `quantity_note`（仕様 1.3 章）・
  `visibility`（仕様 5 章）・`tide_snapshot` / `weather_snapshot`。
- **`methods_default` が 0 件だった**ため初期メソッド 10 件（仕様 8.3 章）を seed。
  既存の `handle_new_user` → `copy_default_methods` が機能するようになった。
- **テスト基盤**: `db/tests/baseline_v1.1_synthetic.sql`（想定ベース）を
  `baseline_v1.1_actual.sql`（実スキーマ）に置き換え、以後は実態に対して検証する。

### D-024: 画面 ID はワイヤーフレーム v7.2 を正とし、認証画面に新 ID を付番（2026-07-18）

- **背景**: ハンドオフ v1.0 の画面一覧は `SCR-001 = ログイン` / `SCR-010 = 会員登録` と
  しているが、ワイヤーフレーム v7.2・確定仕様書・ユーザーストーリー定義書はいずれも
  `SCR-001 = ホーム` / `SCR-010 = ローテーションログ`（メソッドはその中のタブ）としており、
  3 対 1 で後者が一致している。**ワイヤーフレームに認証画面は存在しない。**
- **決定**: ワイヤーフレーム v7.2 の付番を正とし、認証画面には新しい ID を割り当てる。
  - **SCR-016 ログイン** / **SCR-017 会員登録**
  - ハンドオフ 3 章の画面一覧表（SCR-010〜013 の対応）は誤りとして扱う。
- **デザイン**: ワイヤーフレームが存在しないため、v7.2 のデザイントークン
  （カラシ×ブルー v3）を流用して新規設計した。

### D-025: フロントは素の CSS + vendoring した supabase-js（ビルド工程なし）（2026-07-18）

- **決定**: 当面 Tailwind のビルド工程を導入せず、ワイヤーフレーム v7.2 と同じ
  CSS 変数を持つ `frontend/assets/theme.css` を使う。supabase-js は npm から
  取得した UMD ビルドを `frontend/vendor/` に同梱する。
- **理由**: GitHub Pages へ静的ファイルをそのまま配信でき、ビルド・CDN 依存が
  ゼロになる（オフライン耐性・デプロイの単純さ）。ワイヤーフレーム自体が
  素の CSS で書かれているため見た目の再現性も高い。
- **見直し条件**: Phase 2 で画面数が増えて CSS が肥大化したら Tailwind の
  ビルド工程（Pages ワークフローに 1 ステップ追加）を検討する。
