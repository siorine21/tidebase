-- ============================================================
-- 招待できるのは管理者だけにする
--
-- 要望（2026-08-07）: 招待は管理者（自分）だけが使える機能にしたい。
-- 招待して入ってきた人が、さらに別の人を招待できてしまうのは困る。
--
-- 010 の時点では画面側でオーナーにだけ招待 UI を出していたが、
-- **DB の権限としては塞げていなかった**。実際に次の 2 経路が空いていた:
--
--   ① group_invites の "creator manage" ポリシーが
--      WITH CHECK (created_by = auth.uid()) だけだったため、
--      メンバーが自分を created_by にして招待を作れてしまう。
--   ② groups の "create own" が誰でも通るため、メンバーが
--      自分のグループを新規作成 → そのオーナーとして招待し放題になる。
--
-- 画面からボタンを消すのは案内でしかない。ここでは
-- 「管理者だけが招待を作れる」を **RLS とトリガーの両方**で保証する。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- ① 管理者の台帳
--    ポリシーを 1 つも作らない = PostgREST からは誰も読み書きできない。
--    管理者の追加・削除は DB 直（Management API / SQL）でのみ行う。
--    「アプリの操作では絶対に増えない」ことが要件そのものなので、
--    画面から触れる経路を用意しない。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admins (
  user_id    UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note       TEXT
);

COMMENT ON TABLE public.app_admins IS
  '招待とグループ作成ができる管理者。付与は DB 直のみ（アプリからは変更不可）。';

ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_admins FROM PUBLIC, anon, authenticated;

-- 既存の環境を壊さないための移行: いまグループを持っている人を管理者にする。
-- まだグループが無ければ、最初に登録したユーザー（＝本人）を管理者にする。
INSERT INTO public.app_admins (user_id, note)
SELECT DISTINCT g.owner_id, '012 移行: 既存グループのオーナー'
  FROM public.groups g
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.app_admins (user_id, note)
SELECT p.id, '012 移行: 最初のユーザー'
  FROM public.profiles p
 WHERE NOT EXISTS (SELECT 1 FROM public.app_admins)
 ORDER BY p.created_at
 LIMIT 1
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_admins WHERE user_id = auth.uid());
$$;

COMMENT ON FUNCTION public.is_app_admin() IS
  'いまのユーザーが管理者かどうか。画面の出し分けにも使うので authenticated から呼べる。';

GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated;

-- ------------------------------------------------------------
-- ② グループを作れるのは管理者だけ
--    これを塞がないと「自分のグループを作って招待する」で回避される。
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "groups: create own" ON public.groups;
CREATE POLICY "groups: create own" ON public.groups
  FOR INSERT WITH CHECK (owner_id = auth.uid() AND public.is_app_admin());

-- ------------------------------------------------------------
-- ③ 招待を作れるのは「管理者 かつ そのグループのオーナー」だけ
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "group_invites: creator manage" ON public.group_invites;
DROP POLICY IF EXISTS "group_invites: owner manage" ON public.group_invites;

DROP POLICY IF EXISTS "group_invites: admin manage" ON public.group_invites;
CREATE POLICY "group_invites: admin manage" ON public.group_invites
  FOR ALL
  USING (public.is_app_admin() AND public.is_group_owner(group_id))
  WITH CHECK (
    public.is_app_admin()
    AND public.is_group_owner(group_id)
    AND created_by = auth.uid()
  );

-- ------------------------------------------------------------
-- ④ 経路によらず成立させる（RLS を迂回する service_role 等への保険）
--    auth.uid() ではなく行の created_by を見るので、
--    管理用 SQL から入れた行にも同じ規則が効く。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_invite_creator()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_admins WHERE user_id = NEW.created_by) THEN
    RAISE EXCEPTION '招待を作成できるのは管理者だけです'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
     WHERE group_id = NEW.group_id AND user_id = NEW.created_by AND role = 'owner'
  ) THEN
    RAISE EXCEPTION '招待を作成できるのはグループのオーナーだけです'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_group_invite_created ON public.group_invites;
CREATE TRIGGER on_group_invite_created
  BEFORE INSERT ON public.group_invites
  FOR EACH ROW EXECUTE FUNCTION public.guard_invite_creator();

COMMIT;
