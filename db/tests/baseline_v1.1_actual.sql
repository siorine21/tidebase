-- ============================================================
-- v1.1 実スキーマ（本番 Supabase から取得・2026-07-18 突合）
-- テスト専用: ローカル PostgreSQL でマイグレーションを検証するために
-- 本番の適用前状態を再現する。本番には適用しない。
--
-- 取得方法: python3 scripts/supabase_admin.py inspect
-- ※ 旧 baseline_v1.1_synthetic.sql（想定台帳ベース）を置き換え
-- ============================================================

-- Supabase のロールのスタブ（本番には最初から存在する）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

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

-- Supabase の storage スキーマのスタブ（014 の権限設定を検証するため）
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE storage.buckets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  public             BOOLEAN DEFAULT FALSE,
  file_size_limit    BIGINT,
  allowed_mime_types TEXT[],
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE storage.objects (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name      TEXT NOT NULL,
  owner     UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 本番と同じ挙動: パスを「/」で分割して配列にする
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT string_to_array(name, '/');
$$;

-- ------------------------------------------------------------
-- public スキーマ（v1.1 実態）
-- ------------------------------------------------------------
CREATE TABLE public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT UNIQUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.groups (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.spots (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name       TEXT,
  latitude   NUMERIC NOT NULL,
  longitude  NUMERIC NOT NULL,
  water_type TEXT NOT NULL DEFAULT 'saltwater'
             CHECK (water_type IN ('saltwater', 'brackish', 'freshwater')),
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.makers (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE public.tags (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE public.lure_recipes (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  maker_id       UUID REFERENCES public.makers(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  category_large TEXT,
  category_small TEXT,
  color          TEXT,
  weight_g       NUMERIC,
  hook           TEXT,
  condition_memo TEXT,
  is_favorite    BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.recipe_tags (
  recipe_id UUID NOT NULL REFERENCES public.lure_recipes(id) ON DELETE CASCADE,
  tag_id    UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, tag_id)
);

CREATE TABLE public.fishing_records (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  spot_id         UUID REFERENCES public.spots(id) ON DELETE SET NULL,
  recipe_id       UUID REFERENCES public.lure_recipes(id) ON DELETE SET NULL,
  fished_at       DATE NOT NULL,          -- 日付のみ（1日1釣行の単位）
  is_skunked      BOOLEAN DEFAULT FALSE,
  fish_name       TEXT,                   -- v1.2 で fish_species_id に置換
  fish_name_local TEXT,                   -- 出世魚の採用呼称
  length_cm       NUMERIC,
  weight_g        NUMERIC,
  count           INTEGER DEFAULT 1,      -- v1.2 で catch_count にリネーム
  tide_type       TEXT,                   -- 潮回り（tide_correlation ビューの集計キー）
  water_layer     TEXT,                   -- ヒットレンジ
  rod             TEXT,
  reel            TEXT,
  line            TEXT,
  leader          TEXT,
  photo_url       TEXT,
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.methods_default (
  id         SERIAL PRIMARY KEY,
  style      TEXT NOT NULL DEFAULT 'area_trout',
  situation  TEXT NOT NULL,
  action     TEXT NOT NULL,
  sort_order INTEGER
);

CREATE TABLE public.methods (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  style      TEXT NOT NULL DEFAULT 'area_trout',
  situation  TEXT NOT NULL,
  action     TEXT NOT NULL,
  sort_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 潮汐×釣果相関（確定仕様書 14.3 章の集計をそのまま実装）
CREATE VIEW public.tide_correlation AS
SELECT r.user_id,
       r.tide_type,
       count(DISTINCT r.fished_at) AS outing_count,
       count(*) AS catch_count,
       round(count(*)::numeric / NULLIF(count(DISTINCT r.fished_at), 0)::numeric, 1) AS score
FROM public.fishing_records r
JOIN public.spots s ON r.spot_id = s.id
WHERE s.water_type = ANY (ARRAY['saltwater', 'brackish'])
  AND r.is_skunked = false
GROUP BY r.user_id, r.tide_type;

-- RLS（v1.1 実態: methods_default のみ RLS 無効）
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spots           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lure_recipes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fishing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.methods         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: own"        ON public.profiles        FOR ALL USING (auth.uid() = id);
CREATE POLICY "spots: own"           ON public.spots           FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "makers: own"          ON public.makers          FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "tags: own"            ON public.tags            FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "lure_recipes: own"    ON public.lure_recipes    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "fishing_records: own" ON public.fishing_records FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "methods: own"         ON public.methods         FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "recipe_tags: own"     ON public.recipe_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM public.lure_recipes
          WHERE id = recipe_id AND user_id = auth.uid())
);

-- 会員登録時の profiles 作成 + メソッド 10 件コピー（v1.1 実態）
CREATE OR REPLACE FUNCTION public.copy_default_methods(p_user_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.methods (user_id, style, situation, action, sort_order)
  SELECT p_user_id, style, situation, action, sort_order
  FROM public.methods_default ORDER BY sort_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id) ON CONFLICT (id) DO NOTHING;
  PERFORM public.copy_default_methods(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
