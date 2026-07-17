-- ============================================================
-- TIDEBASE DB スキーマ v1.1 → v1.2 差分
-- 適用方法: Supabase ダッシュボード → SQL Editor で実行
-- 根拠: docs/handoff/TIDEBASE_開発ハンドオフ_v1.0.md 2章 / 確定仕様書 v2.4 19章
-- 前提: v1.1（9テーブル + 1ビュー）適用済み
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- ① groups — グループ機能の中核テーブル
-- （Phase 0 手順書で作成済みの環境もあるため IF NOT EXISTS）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.groups (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- ② group_members — グループメンバー管理（owner / member）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_members (
  group_id    UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- ------------------------------------------------------------
-- ③ group_invites — 招待トークン（UUID v4・7日間有効・1人1回）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_invites (
  token       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id    UUID REFERENCES public.groups(id) ON DELETE CASCADE NOT NULL,
  created_by  UUID REFERENCES public.profiles(id) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_by     UUID REFERENCES public.profiles(id),
  used_at     TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- ④ fish_species — 魚種マスタ（user_id NULL = システムデフォルト）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fish_species (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT,     -- 海水 / 淡水 / 汽水
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

-- ------------------------------------------------------------
-- RLS 用ヘルパー
-- group_members ポリシーの自己参照による無限再帰を避けるため
-- SECURITY DEFINER 関数を経由する（DECISIONS D-007）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_group_member(target_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = target_group_id AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_group_owner(target_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = target_group_id AND user_id = auth.uid() AND role = 'owner'
  );
$$;

-- ------------------------------------------------------------
-- RLS: groups
-- ------------------------------------------------------------
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups: member read" ON public.groups;
CREATE POLICY "groups: member read" ON public.groups
  FOR SELECT USING (public.is_group_member(id) OR owner_id = auth.uid());

DROP POLICY IF EXISTS "groups: create own" ON public.groups;
CREATE POLICY "groups: create own" ON public.groups
  FOR INSERT WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "groups: owner update" ON public.groups;
CREATE POLICY "groups: owner update" ON public.groups
  FOR UPDATE USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "groups: owner delete" ON public.groups;
CREATE POLICY "groups: owner delete" ON public.groups
  FOR DELETE USING (owner_id = auth.uid());

-- ------------------------------------------------------------
-- RLS: group_members
-- ------------------------------------------------------------
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "group_members: member read" ON public.group_members;
CREATE POLICY "group_members: member read" ON public.group_members
  FOR SELECT USING (public.is_group_member(group_id));

DROP POLICY IF EXISTS "group_members: owner manage" ON public.group_members;
CREATE POLICY "group_members: owner manage" ON public.group_members
  FOR ALL USING (public.is_group_owner(group_id));

-- メンバー本人の退出（自分の行の削除）
DROP POLICY IF EXISTS "group_members: self leave" ON public.group_members;
CREATE POLICY "group_members: self leave" ON public.group_members
  FOR DELETE USING (user_id = auth.uid());

-- ------------------------------------------------------------
-- RLS: group_invites
-- ------------------------------------------------------------
ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "group_invites: owner manage" ON public.group_invites;
CREATE POLICY "group_invites: owner manage" ON public.group_invites
  FOR ALL USING (public.is_group_owner(group_id));

-- 参加フロー（トークン検証・使用）はサーバー側（service_role）で行う想定。

-- ------------------------------------------------------------
-- RLS: fish_species（デフォルト + 自分のもののみ）
-- ------------------------------------------------------------
ALTER TABLE public.fish_species ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fish_species: read" ON public.fish_species;
CREATE POLICY "fish_species: read" ON public.fish_species
  FOR SELECT USING (user_id IS NULL OR user_id = auth.uid());

DROP POLICY IF EXISTS "fish_species: own write" ON public.fish_species;
CREATE POLICY "fish_species: own write" ON public.fish_species
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 初期 13 種（確定仕様書 1.1 章）— システムデフォルト（user_id = NULL）
INSERT INTO public.fish_species (user_id, name, category) VALUES
  (NULL, 'マルスズキ',   '海水'),
  (NULL, 'ヒラスズキ',   '海水'),
  (NULL, 'クロダイ',     '海水'),
  (NULL, 'キビレ',       '汽水'),
  (NULL, 'タチウオ',     '海水'),
  (NULL, 'ヒラメ',       '海水'),
  (NULL, 'マゴチ',       '海水'),
  (NULL, 'ブリ',         '海水'),
  (NULL, 'サワラ',       '海水'),
  (NULL, 'トラウト',     '淡水'),
  (NULL, 'ナマズ',       '淡水'),
  (NULL, 'ライギョ',     '淡水'),
  (NULL, 'ブラックバス', '淡水')
ON CONFLICT (user_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- ⑤ methods_default — RLS + 全員 READ ポリシー
-- ------------------------------------------------------------
ALTER TABLE public.methods_default ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "methods_default: read all" ON public.methods_default;
CREATE POLICY "methods_default: read all" ON public.methods_default
  FOR SELECT USING (true);

-- ------------------------------------------------------------
-- ⑥ fishing_records.count → catch_count（予約語回避）
-- ------------------------------------------------------------
ALTER TABLE public.fishing_records RENAME COLUMN count TO catch_count;

-- ------------------------------------------------------------
-- ⑦ fishing_records.fish_name → fish_species_id (FK)
--    ※ v1.1 に本番データがある場合は DROP 前に fish_species への
--      移行 INSERT + UPDATE でバックフィルすること（Phase 1 時点はデータなし想定）
-- ------------------------------------------------------------
ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS fish_species_id UUID REFERENCES public.fish_species(id);

ALTER TABLE public.fishing_records DROP COLUMN IF EXISTS fish_name;

-- ------------------------------------------------------------
-- ⑧ インデックス追加
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fishing_records_fished_at
  ON public.fishing_records (fished_at);

CREATE INDEX IF NOT EXISTS idx_spots_water_type
  ON public.spots (water_type);

-- ------------------------------------------------------------
-- ⑨ tide_correlation ビュー — SECURITY INVOKER 明示
-- ------------------------------------------------------------
ALTER VIEW public.tide_correlation SET (security_invoker = true);

COMMIT;
