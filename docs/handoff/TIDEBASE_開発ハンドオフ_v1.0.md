# TIDEBASE 開発ハンドオフドキュメント v1.0

**引き渡し先**: Claude Code
**作成日**: 2026-02-28
**プロジェクトフェーズ**: Phase 0 完了 → Phase 1 開始

---

## 0. プロジェクト概要

### 0.1 プロダクト

TIDEBASE — 釣行記録・ルアーレシピ管理・潮汐相関分析ができる個人向け Web アプリ。

### 0.2 開発方針

| 観点 | 内容 |
|------|------|
| コスト上限 | **月額 $7 以下**（上回る場合は要相談） |
| 現在の見込み | 約 $0.62〜0.67/月 |
| 開発体制 | 個人開発 |
| ターゲット | 釣り愛好家（初期はエリアトラウト中心） |

### 0.3 技術スタック

| 層 | 技術 |
|----|------|
| フロント | HTMX + Tailwind CSS + Vanilla JS |
| バック | AWS Lambda (Python 3.12) + API Gateway |
| DB | Supabase (PostgreSQL + Auth + Storage) |
| ホスティング | CloudFront + S3 |
| 地図 | Google Maps JS API（無料枠内） |
| CI/CD | AWS CodeCommit + SAM |
| ドメイン管理 | Route 53 |
| 開発環境 | Windows 11 Pro + WSL Ubuntu + VSCode |

---

## 1. 現在の進捗状況

### 1.1 完了済み

| Phase | タスク | 状態 |
|-------|--------|------|
| Phase 0 | AWS環境構築（IAM/CodeCommit/SAM） | ✅ |
| Phase 0 | Supabase プロジェクト作成 | ✅ |
| Phase 0 | ping Lambda 稼働確認 | ✅ |
| Phase 0 | SSM Parameter Store 設定 | ✅ |
| Phase 1 | DBスキーマ作成（9テーブル + 1ビュー） | ✅ |
| 設計 | ワイヤーフレーム全15画面 v7.2 | ✅ |
| 設計 | 確定仕様書 v2.4（19章構成） | ✅ |

### 1.2 未完了（Claude Code に引き継ぐ範囲）

| Phase | タスク |
|-------|--------|
| Phase 1 | DBスキーマ追加修正（下記2章参照） |
| Phase 1 | Supabase Auth 実装 |
| Phase 1 | SCR-001 ログイン画面 |
| Phase 1 | SCR-010 会員登録画面 |
| Phase 2 | 全画面実装（SCR-002 〜 SCR-015） |
| Phase 3 | 分析・設定画面 |
| Phase 4 | グループ機能 |
| Phase 5 | 本番デプロイ・GDPR対応 |

---

## 2. DBスキーマ 修正必要項目（Phase 1 冒頭で対応）

現在の `TIDEBASE_DB_schema_v1.1.sql` に以下の追加が必要。

### 2.1 追加が必要なテーブル

| # | テーブル | 理由 |
|---|---------|------|
| ① | `groups` | グループ機能の中核テーブル（19章で定義済みだがスキーマ未作成） |
| ② | `group_members` | グループメンバー管理（役割：owner/member） |
| ③ | `group_invites` | 招待トークン管理（UUID v4・7日間有効・1人1回使用） |
| ④ | `fish_species` | 魚種マスタ（表記ゆれ防止・SCR-006フィルタ用） |

### 2.2 修正が必要な既存テーブル

| # | 対象 | 修正内容 |
|---|------|---------|
| ⑤ | `methods_default` | RLS + 全員READポリシー追加 |
| ⑥ | `fishing_records` | `count` → `catch_count` にリネーム（予約語回避） |
| ⑦ | `fishing_records.fish_name` | `fish_species_id` (FK) に変更 |
| ⑧ | インデックス追加 | `fishing_records.fished_at`, `spots.water_type` |
| ⑨ | `tide_correlation` ビュー | `SECURITY INVOKER` 明示 |

### 2.3 参考SQL（Claude Codeで実装）

```sql
-- ① groups
CREATE TABLE public.groups (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ② group_members
CREATE TABLE public.group_members (
  group_id    UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- ③ group_invites
CREATE TABLE public.group_invites (
  token       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id    UUID REFERENCES public.groups(id) ON DELETE CASCADE NOT NULL,
  created_by  UUID REFERENCES public.profiles(id) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_by     UUID REFERENCES public.profiles(id),
  used_at     TIMESTAMPTZ
);

-- ④ fish_species
CREATE TABLE public.fish_species (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
                 -- NULL = システムデフォルト魚種
  name        TEXT NOT NULL,
  category    TEXT,     -- 海水 / 淡水 / 汽水
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);
```

各テーブルにRLSを設定すること。詳細は確定仕様書 19章 を参照。

---

## 3. 全画面一覧（実装対象）

| ID | 画面名 | Phase | 優先度 |
|----|--------|-------|--------|
| SCR-001 | ログイン | 1 | 高 |
| SCR-002 | 釣果入力（5ステップ） | 2 | 高 |
| SCR-003 | ホーム（週間カレンダー・潮汐相関） | 2 | 高 |
| SCR-004 | スポットマップ | 2 | 高 |
| SCR-005 | スポット詳細（編集・一括変更・削除） | 2 | 中 |
| SCR-006 | 釣果一覧 | 2 | 高 |
| SCR-007 | 釣果詳細（削除機能） | 2 | 中 |
| SCR-008 | ルアーレシピ一覧（3フィルタ） | 2 | 高 |
| SCR-009 | レシピ詳細（削除機能） | 2 | 中 |
| SCR-010 | 会員登録・メソッド管理 | 1-3 | 中 |
| SCR-011 | グループフィード | 4 | 低 |
| SCR-012 | グループ招待 | 4 | 低 |
| SCR-013 | グループ管理（退出・解散・譲渡） | 4 | 低 |
| SCR-014 | 設定 | 3 | 中 |
| SCR-015 | レシピ作成・編集 | 2 | 高 |

---

## 4. 主要仕様サマリ（詳細は確定仕様書参照）

### 4.1 潮汐相関スコア（SCR-003）

- 集計対象：**海水・汽水スポット**のみ（淡水は除外）
- 1日1釣行としてカウント（`fished_at` DATE型基準）
- スコア = 釣果数 ÷ 釣行回数（単位なし・小数第1位）
- ボウズ（`is_skunked = TRUE`）は集計から除外
- 表示：釣行回数・釣果数・スコア + 正規化バー

### 4.2 スポット管理

- 水域区分：**海水 / 汽水 / 淡水** の3種類
  - 汽水 = 河口・干潟・汽水湖・河川
  - 淡水 = エリア・淡水湖・野池・渓流
- 初回登録：地図タップで座標取得 + スポット名入力（任意）
- 2回目以降：ラベル一覧 or 地図ラベルタップで選択
- 削除：釣果紐付き時は不可 → 一括変更画面へ誘導
- 編集：名前・座標・水域区分すべて変更可能

### 4.3 ルアーレシピ

- カテゴリ：大カテゴリ → 小カテゴリ の2段構成
- SCR-008 フィルタ：**カテゴリ・メーカー・タグ**の3ドロップダウン（AND条件）
- SCR-015 レシピ作成：全項目チップUI統一
- メーカー・タグはユーザーごとのマスタ
- チップ操作：× = 選択解除 / 長押し = マスタ削除

### 4.4 メソッド機能（F-11）

- **全メソッド編集・削除可能**（システムデフォルト含む）
- 初回ログイン時に `methods_default` から10件をユーザーごとにコピー
- 完全にユーザー所有データ

### 4.5 グループ機能

- 役割：オーナー / メンバー
- 招待：UUID v4 トークン・7日間有効・1人1回使用
- オーナーが退出したい場合：譲渡 or 解散
- 全操作で各自の釣果記録は保持

### 4.6 UI統一ルール

- カラーテーマ：ネイビー背景 + シアン（#C9A84C）アクセント
- フォント：Bebas Neue（見出し） + JetBrains Mono（数値）
- フィルタ画面 → **ドロップダウン**（SCR-006・SCR-008）
- 入力フォーム画面 → **チップ**（SCR-015）
- 週間カレンダー：**日曜始まり・7日表示・8週先まで**
- 今日の日付：シアンボーダー + 背景ハイライト

---

## 5. コスト管理

### 5.1 現在の月額見込み

| 項目 | 月額 |
|------|------|
| Route 53 ホストゾーン | $0.50 |
| ドメイン（年割） | $0.12〜0.17 |
| Lambda / API Gateway | 無料枠内 $0 |
| Supabase | 無料枠内 $0 |
| Google Maps JS API | 無料枠内 $0 |
| CloudFront + S3 | 無料枠内 $0 |
| **合計** | **約 $0.62〜0.67** |

### 5.2 監視ポイント

- Supabase DB使用量（500MB上限）
- Google Maps 表示回数（月$200クレジット・約28,000回まで）
- Lambda 実行回数（月100万回まで無料）
- S3 ストレージ（5GBまで無料）

### 5.3 コスト超過時の対応

$7 上限を超える見込みが出た場合は Claude Code から報告し、機能スコープ削減を検討する。

---

## 6. 関連ドキュメント一覧

Claude Code は以下のドキュメントすべてを参照して実装すること。

| ドキュメント | 版数 | 内容 |
|------------|------|------|
| `TIDEBASE_開発ハンドオフ_v1.0.md` | v1.0 | **本ドキュメント（起点）** |
| `TIDEBASE_確定仕様書.md` | v2.4 | 全19章の詳細仕様 |
| `TIDEBASE_画面設計_ワイヤーフレーム_v7.2.html` | v7.2 | 全15画面のワイヤーフレーム |
| `TIDEBASE_DB_schema_v1.1.sql` | v1.1 | 既存DBスキーマ（要修正） |
| `TIDEBASE_作業スケジュール_v1.0.md` | v1.0 | Phase別作業計画 |
| `TIDEBASE_Phase0_環境構築手順書_v1.0.md` | v1.0 | Phase 0 完了内容 |
| `TIDEBASE_ユーザーストーリー_詳細要件定義書_v1.0.md` | v1.0 | ユーザー観点の要件 |

---

## 7. Phase 1 実装タスク詳細

### 7.1 タスク①：DBスキーマ v1.2 作成・適用

**内容**
- 上記2章の追加・修正内容を反映
- 既存DB（v1.1適用済み）に差分適用
- Supabase SQL Editor で実行

**成果物**
- `TIDEBASE_DB_schema_v1.2.sql`

### 7.2 タスク②：Supabase Auth 実装

**内容**
- Email/Password認証の有効化
- JWT検証Lambda（Python）
- API Gateway オーソライザー設定

**環境変数**
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` は SSM Parameter Store から取得

### 7.3 タスク③：SCR-001 ログイン画面

**内容**
- HTMX + Tailwind
- Supabase JS SDK でログイン
- 成功時 SCR-003 にリダイレクト

### 7.4 タスク④：SCR-010 会員登録画面

**内容**
- Email/Password登録
- 登録成功時に自動で profiles + methods 10件が作成される（トリガー）
- ログイン画面へ遷移

---

## 8. 開発上の注意事項

### 8.1 RLS を必ず有効化

Supabase の全テーブルで RLS を有効にすること。無効な状態は全ユーザーからアクセス可能になり、セキュリティ事故につながる。

### 8.2 コミット規約

- リポジトリ：AWS CodeCommit
- ブランチ：`master`（デフォルト）
- コミットメッセージ：日本語可・変更内容を簡潔に

### 8.3 環境変数管理

- 機密情報は **必ず SSM Parameter Store** を使用
- `.env` ファイルはコミットしない（`.gitignore`に追加済み前提）
- Lambda では `boto3.client('ssm').get_parameter()` で取得

### 8.4 テスト

- ユニットテスト：pytest（Phase 1 から導入）
- E2E：Playwright（Phase 3 から検討）

---

## 9. コミュニケーション

### 9.1 進捗確認

- 各Phase完了時にユーザー確認を取ること
- 仕様変更が必要な場合は必ず相談
- コスト超過リスクが見えた時点で即報告

### 9.2 判断基準

- 迷ったら **コストを最小化する選択** を優先
- 迷ったら **無料枠内で完結する構成** を優先
- 迷ったら **確定仕様書に従う**

---

*TIDEBASE 開発ハンドオフドキュメント v1.0*
*引き渡し完了日：2026-02-28*
