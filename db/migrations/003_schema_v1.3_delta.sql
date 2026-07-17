-- ============================================================
-- TIDEBASE DB スキーマ v1.2 → v1.3 差分
-- 適用方法: Supabase ダッシュボード → SQL Editor で実行（002 適用後）
-- 根拠: docs/design/TIDEBASE_設計補完_v1.0.md 3〜6 章
-- ⚠️ v1.1 SQL との突合（設計補完書 8 章の台帳）が済んでいない場合、
--    「要確認」列の不足があればこのファイルに ADD COLUMN を追記すること
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
-- fishing_records 拡張（設計補完書 5〜6 章、D-015 / D-016）
-- タックル・写真の API 対応は Phase 2（カラムだけ先行追加）
-- ------------------------------------------------------------
ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS fish_display_name TEXT,
  ADD COLUMN IF NOT EXISTS rod TEXT,
  ADD COLUMN IF NOT EXISTS reel TEXT,
  ADD COLUMN IF NOT EXISTS line TEXT,
  ADD COLUMN IF NOT EXISTS leader TEXT,
  ADD COLUMN IF NOT EXISTS photo_key TEXT;

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
