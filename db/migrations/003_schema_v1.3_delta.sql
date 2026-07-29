-- ============================================================
-- TIDEBASE DB スキーマ v1.2 → v1.3 差分
-- 適用方法: Supabase ダッシュボード → SQL Editor で実行（002 適用後）
-- 根拠: docs/design/TIDEBASE_設計補完_v1.0.md 3〜6 章
-- 2026-07-18 の実 DB 突合結果を反映済み（D-023）
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- spots 拡張（設計補完書 4 章、D-014）
-- ------------------------------------------------------------
ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS spot_type TEXT
    CHECK (spot_type IN ('surf', 'rock', 'port', 'managed', 'river')),
  ADD COLUMN IF NOT EXISTS low_tide_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'group'
    CHECK (visibility IN ('group', 'private')),
  ADD COLUMN IF NOT EXISTS tide_station_code TEXT;

-- ------------------------------------------------------------
-- fishing_records 拡張（v1.1 突合で不足が判明したカラムのみ）
--
-- v1.1 に既に存在するため追加しないもの:
--   fish_name_local（出世魚の採用呼称）/ length_cm（サイズ）/ weight_g /
--   water_layer（ヒットレンジ）/ rod・reel・line・leader（タックル）/
--   photo_url（写真。Supabase Storage のパスを格納）/
--   tide_type（潮回り。tide_correlation ビューの集計キー）
-- ------------------------------------------------------------
ALTER TABLE public.fishing_records
  -- 数量メモ（確定仕様書 1.3 章・エリアトラウト向け）
  ADD COLUMN IF NOT EXISTS quantity_note TEXT,
  -- 公開範囲（確定仕様書 5 章・Phase 1 から選択可）
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'group'
    CHECK (visibility IN ('group', 'private')),
  -- 潮汐・天気の詳細スナップショット（D-012）。
  -- 集計キーの tide_type カラムとはトリガーで整合させる
  ADD COLUMN IF NOT EXISTS tide_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS weather_snapshot JSONB;

-- ------------------------------------------------------------
-- 出世魚判定ルール（設計補完書 5 章、D-015）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fish_name_rules (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_group   TEXT NOT NULL,        -- 'buri' / 'suzuki' / 'sawara'
  display_name TEXT NOT NULL,
  min_cm       NUMERIC(5,1),         -- NULL = 下限なし（min <= size < max）
  max_cm       NUMERIC(5,1),         -- NULL = 上限なし
  region       TEXT NOT NULL DEFAULT 'kanto',
  sort_order   INTEGER NOT NULL,
  UNIQUE (rule_group, region, sort_order)
);

ALTER TABLE public.fish_name_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fish_name_rules: read all" ON public.fish_name_rules;
CREATE POLICY "fish_name_rules: read all" ON public.fish_name_rules
  FOR SELECT USING (true);

-- seed（確定仕様書 1.2 章・関東呼称）
INSERT INTO public.fish_name_rules
  (rule_group, display_name, min_cm, max_cm, region, sort_order) VALUES
  ('buri',   'ワカシ', NULL, 35,   'kanto', 1),
  ('buri',   'イナダ', 35,   60,   'kanto', 2),
  ('buri',   'ワラサ', 60,   80,   'kanto', 3),
  ('buri',   'ブリ',   80,   NULL, 'kanto', 4),
  ('suzuki', 'セイゴ', NULL, 30,   'kanto', 1),
  ('suzuki', 'フッコ', 30,   60,   'kanto', 2),
  ('suzuki', 'スズキ', 60,   NULL, 'kanto', 3),
  ('sawara', 'サゴシ', NULL, 50,   'kanto', 1),
  ('sawara', 'サワラ', 50,   NULL, 'kanto', 2)
ON CONFLICT (rule_group, region, sort_order) DO NOTHING;

-- 魚種マスタに判定グループを紐付け
ALTER TABLE public.fish_species
  ADD COLUMN IF NOT EXISTS name_rule_group TEXT;

UPDATE public.fish_species SET name_rule_group = 'buri'
  WHERE user_id IS NULL AND name = 'ブリ';
UPDATE public.fish_species SET name_rule_group = 'suzuki'
  WHERE user_id IS NULL AND name IN ('マルスズキ', 'ヒラスズキ');
UPDATE public.fish_species SET name_rule_group = 'sawara'
  WHERE user_id IS NULL AND name = 'サワラ';

COMMIT;
