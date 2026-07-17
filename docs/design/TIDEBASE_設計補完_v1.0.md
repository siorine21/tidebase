# 🎣 TIDEBASE 設計補完書 v1.0

> **2026-07-17 | 設計レビューで検出した不足部分の確定設計**
>
> 本書は確定仕様書 v2.4 の「補完」であり、両者が矛盾する箇所は**本書を正**とする。
> 各節の決定サマリは `docs/DECISIONS.md`（D-013〜D-019）に登録済み。

| # | 対象 | レビュー指摘 | 実装 Phase |
|---|------|------------|-----------|
| 1 | 天気・波高データソース | 指摘 6 | 2 |
| 2 | 天気スナップショット自動付与 | 指摘 7 派生 | 2 |
| 3 | 最寄り潮汐観測点マッピング | 指摘 19 | 1 残 |
| 4 | スポット拡張フィールド | 指摘 10 | 1 残 + 2 |
| 5 | 出世魚判定 | 指摘 11 | 1 残 |
| 6 | タックル・写真 | 指摘 11 | 2 |
| 7 | 釣行スコア算出 | 仕様曖昧の裁定 | 2 |
| 8 | 想定スキーマ台帳 | 指摘 4 対策 | — |
| 9 | CI | 構成提言 | 1 残 |
| 10 | 認証・画面フロー | ハンドオフ 7.2〜7.4 補足 | 1 残 |

---

## 1. 天気・波高データソース（F-02 改訂）

### 1.1 決定: OpenWeatherMap → Open-Meteo に置換（D-013）

確定仕様書 3 章は波高を「OpenWeatherMap から自動取得」としているが、OWM 無料プランに
波高・海象データは存在しないため実現不能。以下に置き換える。

| 用途 | Open-Meteo API | 主なパラメータ |
|------|---------------|--------------|
| 天気・気温・風 | Forecast API (`/v1/forecast`) | `temperature_2m, weather_code, wind_speed_10m, wind_direction_10m`（hourly） |
| 波高 | Marine API (`/v1/marine`) | `wave_height`（hourly） |
| 過去釣行の後追い | Historical Weather API (`/v1/archive`) | 同上（1940 年〜） |

- 無料・API キー不要・非商用 10,000 リクエスト/日 → 1 人運用で余裕（月額 $0 維持）
- `OPENWEATHER_API_KEY` は廃止（`.env.example` から削除）
- 風速の単位は `wind_speed_unit=ms` を明示指定（仕様 3 章: m/s）
- Marine API は海上グリッドのみ対応。内陸座標は `wave_height = null` として扱う

### 1.2 天気 API 設計（Phase 2）

```
GET /api/v1/weather?lat=35.31&lng=139.48&date=2026-07-17
→ 200
{
  "date": "2026-07-17",
  "hourly": [                          // 0時〜24時間後、3時間刻み（9点）
    {
      "time": "2026-07-17T00:00:00+09:00",
      "temp_c": 24.1,
      "weather_code": 2,               // WMO コード（フロントでアイコン変換）
      "wind_speed_ms": 3.4,
      "wind_dir_deg": 180,
      "wave_height_m": 0.6             // Marine API 対象外の座標は null
    }, ...
  ],
  "source": "open-meteo.com"
}
```

- 認証不要（D-009 と同基準: 公的データ・ユーザーデータなし）
- 3 時間刻みへの間引きはサーバー側で行う（仕様 3 章「0 時から 3 時間単位」）
- キャッシュ: `(丸めた座標 0.1 度, date)` キーで Lambda メモリ内 15 分
- 失敗時: 502。フロントは天気セクションのみ非表示（画面全体は落とさない）

---

## 2. 天気スナップショット自動付与（D-012 拡張・Phase 2）

釣果作成時、`weather_snapshot` 未指定 かつ `spot_id` あり の場合にサーバー側で付与する。

```jsonc
// fishing_records.weather_snapshot
{
  "temp_c": 24.1,
  "weather_code": 2,
  "wind_speed_ms": 3.4,
  "wind_dir_deg": 180,
  "wave_height_m": 0.6,        // 海水・汽水のみ。淡水/取得不可は null
  "method": "open_meteo"       // 世代識別（D-012 と同パターン）
}
```

- `fished_at`（JST）に最も近い hourly 値を採用。過去日は Historical API に切替
- **取得失敗で釣果登録を失敗させない**。`weather_snapshot = null` で登録成功とし、
  クライアントに警告フィールド（`"warnings": ["weather_unavailable"]`）を返す
- `fished_at` / `spot_id` 変更時の再計算は D-012 の tide_snapshot と同じルール
  （`method` が自動付与値 or null のときのみ再計算）

---

## 3. 最寄り潮汐観測点マッピング（Phase 1 残）

要件（要件定義書 2.3「最寄り潮汐観測点: 座標から自動選択」）の実現設計。

### 3.1 観測点マスタ

- `backend/app/data/jma_tide_stations.json` に気象庁の潮位表掲載地点（約 100 点）を静的保持

```jsonc
[
  { "code": "TK", "name": "東京", "lat": 35.6544, "lng": 139.7708 },
  { "code": "YH", "name": "横浜", "lat": 35.4517, "lng": 139.6425 }, ...
]
```

- 更新頻度が極めて低い公的データのため DB でなくリポジトリ内 JSON で管理
  （デプロイと一緒に更新・テスト容易・DB 容量ゼロ）

### 3.2 スポットへの自動設定

- `spots.tide_station_code TEXT`（nullable）を追加
- スポット作成時・座標更新時にハバーサイン距離で最近傍観測点を自動設定
- `water_type = 'freshwater'` は潮汐対象外のため `NULL` を設定
- レスポンスに `tide_station_code` と `tide_station_name` を含める（手動上書きも可）

### 3.3 潮汐 API の拡張

```
GET /api/v1/tide?spot_id={uuid}&date=2026-07-17   // station= の代わりに spot_id を許可
```

- サーバー側で spot → `tide_station_code` を解決。淡水スポットは 400
  （`"淡水スポットは潮汐データの対象外です"`）
- 既存の `station=` 直接指定も維持（地点切替タブ用）

---

## 4. スポット拡張フィールド（指摘 10 の裁定）

確定仕様書 15.3（最小スキーマ）と要件定義書 2.3（リッチスキーマ）の矛盾を以下で裁定する。

### 4.1 Phase 1 で追加（機能の根拠があるもの）

| カラム | 型 | 根拠 |
|--------|----|------|
| `spot_type` | TEXT CHECK: `surf / rock / port / managed / river` | ピン色分け・US-303。任意（NULL 可） |
| `low_tide_only` | BOOLEAN NOT NULL DEFAULT FALSE | US-201（Phase 1・優先度高）。ON で ⚠️ マーカー |
| `visibility` | TEXT NOT NULL DEFAULT 'group' CHECK: `group / private` | 確定仕様書 5 章「最初から用意しておく」 |
| `tide_station_code` | TEXT（nullable） | 本書 3 章 |

```sql
-- db/migrations/003_schema_v1.3_delta.sql（実装時に作成）
ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS spot_type TEXT
    CHECK (spot_type IN ('surf', 'rock', 'port', 'managed', 'river')),
  ADD COLUMN IF NOT EXISTS low_tide_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'group'
    CHECK (visibility IN ('group', 'private')),
  ADD COLUMN IF NOT EXISTS tide_station_code TEXT;
```

### 4.2 Phase 2 に送るもの（画面実装と同時）

`depth_m NUMERIC(4,1)` / `bottom_type TEXT` / `access_memo TEXT` / `point_memo TEXT` /
`target_species TEXT[]`（要件定義書 2.3 の残り）

### 4.3 ピン色マッピング（フロント定数）

| spot_type | 色 | 出典 |
|-----------|----|------|
| surf | `#4A9ECC`（青） | 要件定義書 2.3 |
| rock / managed | `#4CAF50`（緑） | 同上 |
| port | `#C9A84C`（カラシ） | 同上 |
| river | `#6E9ECF`（青灰） | **本書で補完**（仕様に定義なし） |
| 未設定（NULL） | `#9AA5B1`（グレー） | 本書で補完 |
| `low_tide_only = true` | 上記色 + ⚠️ バッジ | US-201 |

### 4.4 water_type との関係

`spot_type` と `water_type` は**独立**とする（例: 管理釣り場は通常 freshwater だが強制しない。
河口の port は brackish がありうる）。UI 側で spot_type 選択時に water_type の初期値を
提案するのみ（surf/rock/port→海水、river→汽水、managed→淡水）。

---

## 5. 出世魚判定（US-101 / US-205・Phase 1 残）

### 5.1 データ設計 — `fish_name_rules`（システムマスタ）

```sql
CREATE TABLE public.fish_name_rules (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_group   TEXT NOT NULL,        -- 'buri' / 'suzuki' / 'sawara'
  display_name TEXT NOT NULL,        -- ワカシ・イナダ・…
  min_cm       NUMERIC(5,1),         -- NULL = 下限なし
  max_cm       NUMERIC(5,1),         -- NULL = 上限なし（min <= size < max）
  region       TEXT NOT NULL DEFAULT 'kanto',
  sort_order   INTEGER NOT NULL
);
ALTER TABLE public.fish_name_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fish_name_rules: read all" ON public.fish_name_rules
  FOR SELECT USING (true);

-- fish_species（システムデフォルト行）に判定グループを紐付け
ALTER TABLE public.fish_species ADD COLUMN IF NOT EXISTS name_rule_group TEXT;
UPDATE public.fish_species SET name_rule_group = 'buri'    WHERE user_id IS NULL AND name = 'ブリ';
UPDATE public.fish_species SET name_rule_group = 'suzuki'  WHERE user_id IS NULL AND name IN ('マルスズキ', 'ヒラスズキ');
UPDATE public.fish_species SET name_rule_group = 'sawara'  WHERE user_id IS NULL AND name = 'サワラ';
```

**seed（確定仕様書 1.2 章・関東呼称）**

| rule_group | display_name | min_cm | max_cm |
|-----------|--------------|--------|--------|
| buri | ワカシ | — | 35 |
| buri | イナダ | 35 | 60 |
| buri | ワラサ | 60 | 80 |
| buri | ブリ | 80 | — |
| suzuki | セイゴ | — | 30 |
| suzuki | フッコ | 30 | 60 |
| suzuki | スズキ | 60 | — |
| sawara | サゴシ | — | 50 |
| sawara | サワラ | 50 | — |

### 5.2 API 設計

```
GET /api/v1/fish-name/suggest?fish_species_id={uuid}&size_cm=42.5
→ 200 { "suggested_name": "イナダ", "rule_group": "buri", "matched": true }
→ 200 { "suggested_name": null, "rule_group": null, "matched": false }  // 対象外魚種
```

- **提案にとどめ強制しない**（確定仕様書 1.2 章）。フロントは STEP1 のサイズ入力時に
  HTMX で呼び、「イナダ として記録しますか？」を表示するだけ
- 採用された呼称は `fishing_records.fish_display_name TEXT`（新設・任意）に保存する。
  `fish_species_id` は親魚種（ブリ）のまま変えない — 集計は親魚種単位、表示は呼称
- 地域差（関西呼称）は `region` カラムで将来対応（ユーザー設定 Phase 4〜）

---

## 6. タックル・写真（F-01 STEP2 / STEP4・Phase 2）

### 6.1 タックル

`fishing_records` に自由入力 4 列を追加（構造化はしない — 個人利用でマスタ管理は過剰）:
`rod TEXT` / `reel TEXT` / `line TEXT` / `leader TEXT`

### 6.2 写真アップロード（S3 署名付き URL 方式）

```
① POST /api/v1/uploads/presign  { "content_type": "image/jpeg" }
   → 201 { "upload_url": "...", "key": "photos/{user_id}/{uuid}.jpg", "expires_in": 300 }
② クライアントが upload_url へ直接 PUT（API を経由しない = Lambda 転送コストゼロ）
③ 釣果の作成/更新で photo_key を保存（fishing_records.photo_key TEXT）
④ 取得時: RecordOut に photo_url（署名付き GET・有効 1 時間）を動的生成して含める
```

- バケット: `tidebase-media-dev`（非公開・Phase 0 作成済み）
- 制約: `content_type` は `image/jpeg | image/png | image/webp` のみ、
  presigned POST の `content-length-range` で 5MB 上限（仕様 3.1 章）
- キーに user_id プレフィックスを含め、presign 発行時に本人確認（他人のキーを発行不可）
- 削除: 釣果削除時に S3 オブジェクトも削除（ベストエフォート・失敗しても釣果削除は成功）
- Lambda に `S3CrudPolicy`（対象バケット限定）を追加

---

## 7. 釣行スコア算出（SCR-003・Phase 2）

確定仕様書の 5 段階表は「若潮」と条件の重なりが未定義のため、以下の**決定的アルゴリズム**に落とす。

```python
def fishing_score(tide: str, weather: str, wind_ms: float) -> int:
    """tide: 大潮/中潮/小潮/長潮/若潮, weather: sunny/cloudy/rain/storm"""
    if weather == "storm" or wind_ms >= 15:
        return 1                                    # 嵐・台風レベル
    if weather == "rain" or wind_ms > 10:
        return 2                                    # 悪天候 or 強風
    if tide == "大潮" and weather in ("sunny", "cloudy") and wind_ms <= 5:
        return 5
    if tide == "中潮" and weather in ("sunny", "cloudy") and wind_ms <= 7:
        return 4
    return 3                                        # 小潮・長潮・若潮ほか残り全部
```

- **裁定 1**: 若潮・長潮は「3」のグループに含める（表の「小潮 or 長潮」を拡張）
- **裁定 2**: 条件を上（悪い方）から評価し、最初に該当した値を返す —
  「大潮 + 雨」は 2、「中潮 + 風 8m」は 3 に落ちる
- weather 区分は Open-Meteo の WMO weather_code からマッピング:
  `0-2 → sunny` / `3, 45, 48 → cloudy` / `51-67, 80-82 → rain` / `95-99 → storm`
  （61 以上の本降り・雷雨系は rain/storm、詳細表は実装時にテストで固定）
- API: `GET /api/v1/fishing-score?spot_id=&date=`（Phase 2、ホーム画面用）。
  内部で tide_type（D-002）+ 天気（本書 1 章）を合成

---

## 8. 想定スキーマ台帳（v1.1 SQL 突合用）

現 API 実装が前提とするカラム。**v1.1 SQL 入手後、このチェックリストで突合する**（指摘 4）。

| テーブル | カラム | 型想定 | 状態 |
|---------|--------|--------|------|
| fishing_records | id / user_id / created_at | uuid / uuid / timestamptz | v1.1 想定 |
| fishing_records | fished_at | timestamptz | v1.1 想定 |
| fishing_records | spot_id | uuid FK → spots | v1.1 想定 |
| fishing_records | catch_count | integer | **v1.2 でリネーム** |
| fishing_records | fish_species_id | uuid FK → fish_species | **v1.2 で追加** |
| fishing_records | size_cm | numeric | v1.1 想定 |
| fishing_records | quantity_note / memo | text | v1.1 想定・要確認 |
| fishing_records | is_skunked | boolean | v1.1 想定 |
| fishing_records | recipe_id | uuid FK → lure_recipes | v1.1 想定 |
| fishing_records | hit_range | text | v1.1 想定・要確認 |
| fishing_records | visibility | text ('group'/'private') | v1.1 想定・要確認 |
| fishing_records | tide_snapshot / weather_snapshot | jsonb | v1.1 想定・要確認 |
| fishing_records | fish_display_name / rod / reel / line / leader / photo_key | text | **v1.3 で追加予定** |
| spots | id / user_id / name / latitude / longitude / water_type / created_at | 15.3 章どおり | v1.1〜1.2 想定 |
| spots | spot_type / low_tide_only / visibility / tide_station_code | 本書 4 章 | **v1.3 で追加予定** |

> ⚠️ 「要確認」の列が v1.1 に無い場合、v1.3 マイグレーションに ADD COLUMN を追記する。

---

## 9. CI（GitHub Actions・Phase 1 残）

CodeCommit は新規受付終了のため GitHub に一本化（D-008 改訂）。デプロイは当面手動
（`make deploy-dev`）とし、CI はテストのみ回す。

```yaml
# .github/workflows/ci.yml（実装時に作成）
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: backend/requirements-dev.txt
      - run: pip install -r backend/requirements-dev.txt
      - run: pytest backend/tests/ -v
```

- デプロイ自動化（`sam deploy` + OIDC ロール）は Phase 5 で検討（コスト・事故リスク優先）

---

## 10. 認証・画面フロー補足（SCR-001 / SCR-010・Phase 1 残）

ハンドオフ 7.2〜7.4 章の実装を D-003 / D-010 に合わせて具体化する。

```
[静的フロント (CloudFront + S3)]
  SCR-001 ログイン / SCR-010 会員登録
    └ supabase-js v2 で signInWithPassword / signUp
    └ セッション管理・リフレッシュは SDK 任せ（localStorage）
    └ API 呼び出しは fetch ラッパーで
       Authorization: Bearer {session.access_token} を自動付与
[API (同一 CloudFront の /api/* → API Gateway)]
    └ 本リポジトリの FastAPI（JWKS 検証済み・D-003）
```

- API Gateway オーソライザー（ハンドオフ 7.2 章）は**採用しない**。
  検証は FastAPI 依存で完結しており、オーソライザー Lambda を挟むと
  コールドスタートが 2 段になるだけで利点がない（決定として D-003 に含む）
- Supabase Auth 設定: Email/Password 有効化、Site URL = CloudFront ドメイン（D-010）、
  確認メールは Supabase 内蔵 SMTP（無料枠: 1時間 2 通 — 個人利用なら十分、SES 不要）
- 会員登録時の profiles + methods 10 件コピーは既存の `handle_new_user` トリガー前提
  （v1.1 突合対象。無ければ v1.3 で追加）

---

## 11. 実装順序（Phase 1 残タスクの更新版）

| 順 | タスク | 依存 |
|----|--------|------|
| 1 | v1.1 SQL 突合（8 章の台帳） → v1.3 マイグレーション作成 | ユーザーから v1.1 入手 |
| 2 | CI 追加（9 章） | なし |
| 3 | 潮汐観測点マスタ + spots 拡張（3・4 章） | v1.3 |
| 4 | 出世魚判定 API（5 章） | v1.3 |
| 5 | Supabase Auth 設定 + SCR-001 / SCR-010（10 章） | なし |
| 6 | 気象庁 API 実疎通確認（サンドボックス外） | ユーザー環境 |

Phase 2 以降: 天気 API・weather_snapshot（1・2 章）→ 写真（6 章）→ 釣行スコア（7 章）→ 画面実装。

---

*TIDEBASE 設計補完書 v1.0 — 2026-07-17*
