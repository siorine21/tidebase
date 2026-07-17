-- ============================================================
-- 合成 v1.1 ベースライン（テスト専用・本番には適用しない）
--
-- 実際の v1.1 スキーマは Supabase 上にあり未突合のため、
-- 設計補完書 8 章の「想定スキーマ台帳」に基づいて最小再現する。
-- 実 DB との突合（make db-inspect）で差異が見つかった場合は
-- このファイルと migration を修正すること。
-- ============================================================

-- Supabase の auth スキーマのスタブ
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id UUID PRIMARY KEY
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- v1.1 相当の public スキーマ（台帳の「v1.1 想定」列のみ）
CREATE TABLE public.profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username     TEXT UNIQUE,
  display_name TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.spots (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES public.profiles(id) NOT NULL,
  name        TEXT,
  latitude    NUMERIC(9,6) NOT NULL,
  longitude   NUMERIC(9,6) NOT NULL,
  water_type  TEXT NOT NULL DEFAULT 'saltwater'
              CHECK (water_type IN ('saltwater', 'brackish', 'freshwater')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.lure_recipes (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES public.profiles(id) NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.fishing_records (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID REFERENCES public.profiles(id) NOT NULL,
  spot_id          UUID REFERENCES public.spots(id),
  fished_at        TIMESTAMPTZ NOT NULL,
  fish_name        TEXT,                -- v1.2 で fish_species_id に置換
  size_cm          NUMERIC(5,1),
  count            INTEGER DEFAULT 1,   -- v1.2 で catch_count にリネーム
  quantity_note    TEXT,
  is_skunked       BOOLEAN DEFAULT FALSE,
  recipe_id        UUID REFERENCES public.lure_recipes(id),
  hit_range        TEXT,
  memo             TEXT,
  visibility       TEXT DEFAULT 'group',
  tide_snapshot    JSONB,
  weather_snapshot JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.methods_default (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  style      TEXT NOT NULL DEFAULT 'area_trout',
  situation  TEXT NOT NULL,
  action     TEXT NOT NULL,
  sort_order INTEGER
);

-- tide_correlation ビュー（v1.1 の実定義は未確認のためスタブ）
CREATE VIEW public.tide_correlation AS
SELECT
  r.tide_snapshot->>'tide_type' AS tide_type,
  COUNT(DISTINCT (r.fished_at AT TIME ZONE 'Asia/Tokyo')::date) AS outing_count,
  COUNT(*) AS catch_count
FROM public.fishing_records r
GROUP BY r.tide_snapshot->>'tide_type';
