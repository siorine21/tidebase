-- ============================================================
-- groups.owner_id に外部キーを付ける
--
-- 2026-08-08 に招待まわりを検証していて見つけた欠落。
-- `groups` には**外部キーが 1 本も無く**（PRIMARY KEY だけ）、
-- オーナーのアカウントを消してもグループが残ってしまっていた。
--
-- 残ると何が困るか:
--   `is_group_owner()` は owner_id = auth.uid() で判定するので、
--   居ないユーザーが owner のグループは**誰もオーナーになれない**。
--   招待も作れず、名前も変えられず、メンバーは抜けることしかできない。
--   これは「そこから出られない状態」で、D-059 で直した詰みと同じ種類の問題。
--
-- 子テーブル（group_members / group_invites）は最初から
-- ON DELETE CASCADE なので、グループが消えれば一緒に片付く。
--
-- 参照先は profiles（auth.users ではなく）。既存の group_members /
-- group_invites と揃える。profiles 自体が auth.users を
-- ON DELETE CASCADE で参照しているので、退会すれば連鎖して消える。
-- ============================================================

BEGIN;

-- 参照先が居ないグループが残っていると FK を張れない。
-- 誰もオーナーになれない＝機能しないグループなので、先に片付ける
DELETE FROM public.groups g
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.owner_id);

ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_owner_id_fkey;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.groups.owner_id IS
  'グループのオーナー。招待を作れるのはこの人（かつ管理者）だけ（012）。'
  '退会したらグループも消える（オーナー不在のグループは誰も管理できないため）。';

COMMIT;
