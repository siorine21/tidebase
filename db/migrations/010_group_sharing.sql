-- ============================================================
-- グループ共有と招待制の会員登録
--
-- 目的（ユーザー要望 2026-08-07）:
--   1. 不特定多数には公開しない。LINE などで招待した人だけ登録できる。
--   2. 他人の釣果だと分かるようにする。
--   3. 他人の釣果は編集できないようにする。
--
-- 設計方針: **既存の RLS は 1 つも緩めない**。
--   fishing_records / spots / lure_recipes / profiles はこれまで通り
--   「自分の行だけ」のまま。共有は、必要な列だけを返す読み取り専用ビュー
--   public.record_feed を新設して行う。
--   こうすると
--     - 他人の釣果は UPDATE / DELETE できない（3 は RLS がそのまま保証する）
--     - スポットの緯度経度など、共有したくない列がビューに無い以上
--       API 経由でも漏れない（列単位で意図した分だけ出す）
--   という 2 点が「画面の作り」ではなく DB の性質として保証される。
--
-- 注意: security_invoker を付けないビューは所有者権限で動くため、
--   ビューの WHERE 句そのものが認可の境界になる。ここを間違えると
--   全ユーザーの釣果が見えるので、db/tests/test_migrations.sql で
--   他人の非公開・非メンバーの行が出ないことを検証している。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- ① 同じグループに属しているか
--    group_members の RLS を再帰させないため SECURITY DEFINER
--    （D-007 と同じ理由）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shares_group_with(other_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members mine
    JOIN public.group_members theirs ON theirs.group_id = mine.group_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = other_user_id
  );
$$;

COMMENT ON FUNCTION public.shares_group_with(UUID) IS
  'auth.uid() と指定ユーザーが同じグループに属していれば true。';

-- ------------------------------------------------------------
-- ② 表示名。profiles.username は任意なので、未設定なら「メンバー」
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.display_name(username TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(TRIM(username), ''), 'メンバー');
$$;

-- ------------------------------------------------------------
-- ③ record_feed — 釣果の読み取り用ビュー
--
--    出す行: 自分の釣果すべて + 同じグループの人の visibility = 'group' の釣果
--    出す列: 画面に必要な分だけ。**スポットの緯度経度は含めない**
--            （どこで釣ったかの名前までは共有するが、座標までは渡さない）
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.record_feed;

-- security_invoker = false を明示する。既定に頼ると、将来 Supabase 側の
-- 既定が変わったときに黙って挙動が変わる。
CREATE VIEW public.record_feed WITH (security_invoker = false) AS
SELECT
  r.id,
  r.user_id,
  (r.user_id = auth.uid())          AS is_mine,
  public.display_name(p.username)          AS owner_name,
  r.fished_at,
  r.is_skunked,
  r.fish_species_id,
  COALESCE(r.fish_name_local, fs.name) AS fish_label,
  fs.name                           AS species_name,
  r.fish_name_local,
  r.length_cm,
  r.weight_g,
  r.catch_count,
  r.quantity_note,
  r.tide_type,
  r.tide_snapshot,
  r.water_layer,
  r.rod, r.reel, r.line, r.leader,
  r.memo,
  r.visibility,
  r.created_at,
  r.spot_id,
  s.name                            AS spot_name,
  s.water_type                      AS spot_water_type,
  r.recipe_id,
  lr.name                           AS recipe_name
FROM public.fishing_records r
JOIN public.profiles p            ON p.id = r.user_id
LEFT JOIN public.spots s          ON s.id = r.spot_id
LEFT JOIN public.fish_species fs  ON fs.id = r.fish_species_id
LEFT JOIN public.lure_recipes lr  ON lr.id = r.recipe_id
WHERE r.user_id = auth.uid()
   OR (r.visibility = 'group' AND public.shares_group_with(r.user_id));

COMMENT ON VIEW public.record_feed IS
  '釣果の読み取り用。自分の全件 + 同じグループの公開釣果。書き込みは fishing_records へ。';

-- 未ログイン（anon）からは一切見せない
REVOKE ALL ON public.record_feed FROM PUBLIC;
REVOKE ALL ON public.record_feed FROM anon;
GRANT SELECT ON public.record_feed TO authenticated;

-- ------------------------------------------------------------
-- ④ グループのメンバー一覧（表示名つき）
--    profiles の RLS は「自分だけ」のままなので、名前はここから取る。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.group_member_names;

CREATE VIEW public.group_member_names WITH (security_invoker = false) AS
SELECT
  gm.group_id,
  gm.user_id,
  gm.role,
  gm.joined_at,
  (gm.user_id = auth.uid()) AS is_me,
  public.display_name(p.username)  AS name
FROM public.group_members gm
JOIN public.profiles p ON p.id = gm.user_id
WHERE public.is_group_member(gm.group_id);

REVOKE ALL ON public.group_member_names FROM PUBLIC;
REVOKE ALL ON public.group_member_names FROM anon;
GRANT SELECT ON public.group_member_names TO authenticated;

-- ------------------------------------------------------------
-- ⑤ 招待
-- ------------------------------------------------------------
-- 誰に送った招待かを控えておく（「たろう」など）。リンクの取り違え防止。
ALTER TABLE public.group_invites
  ADD COLUMN IF NOT EXISTS label TEXT;

ALTER TABLE public.group_invites
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 招待の参照が退会を妨げないようにする。
-- 既定（NO ACTION）のままだと、招待を使って入った人が退会しようとした時点で
-- 外部キー違反になり、アカウントを消せない（005 と同じ種類の落とし穴）。
ALTER TABLE public.group_invites
  DROP CONSTRAINT IF EXISTS group_invites_used_by_fkey;
ALTER TABLE public.group_invites
  ADD CONSTRAINT group_invites_used_by_fkey
  FOREIGN KEY (used_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.group_invites
  DROP CONSTRAINT IF EXISTS group_invites_created_by_fkey;
ALTER TABLE public.group_invites
  ADD CONSTRAINT group_invites_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 招待を作った本人が消せるように（既存の "owner manage" は残す）
DROP POLICY IF EXISTS "group_invites: creator manage" ON public.group_invites;
CREATE POLICY "group_invites: creator manage" ON public.group_invites
  FOR ALL USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

-- グループの人数上限。個人利用（本人 + 友人数名）を想定した歯止めで、
-- 招待リンクが漏れても無制限には増えないようにする。
CREATE OR REPLACE FUNCTION public.group_member_limit()
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 8 $$;

-- 招待の下見（Edge Function の GET 用）。トークンを知っている人にだけ
-- 「誰からの、どのグループへの招待か」を返す。メールアドレス等は返さない。
CREATE OR REPLACE FUNCTION public.peek_invite(invite_token UUID)
RETURNS TABLE (valid BOOLEAN, reason TEXT, group_name TEXT, inviter TEXT, label TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  inv public.group_invites;
BEGIN
  SELECT * INTO inv FROM public.group_invites WHERE token = invite_token;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF inv.used_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'used', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF inv.expires_at <= NOW() THEN
    RETURN QUERY SELECT FALSE, 'expired', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF (SELECT COUNT(*) FROM public.group_members WHERE group_id = inv.group_id)
     >= public.group_member_limit() THEN
    RETURN QUERY SELECT FALSE, 'full', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT TRUE, NULL::TEXT, g.name, public.display_name(p.username), inv.label
    FROM public.groups g
    JOIN public.profiles p ON p.id = inv.created_by
    WHERE g.id = inv.group_id;
END;
$$;

-- 招待を「使用中」にする（アカウント作成の前に押さえる）。
-- 同時に 2 人が同じリンクを開いても 1 人しか通らないよう、単一の UPDATE で
-- 原子的に確保する。確保できたら group_id を返す。
CREATE OR REPLACE FUNCTION public.claim_invite(invite_token UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  claimed_group UUID;
BEGIN
  UPDATE public.group_invites
     SET used_at = NOW()
   WHERE token = invite_token
     AND used_at IS NULL
     AND expires_at > NOW()
     AND (SELECT COUNT(*) FROM public.group_members m
           WHERE m.group_id = group_invites.group_id) < public.group_member_limit()
  RETURNING group_id INTO claimed_group;

  RETURN claimed_group;   -- 確保できなければ NULL
END;
$$;

-- 確保した招待を戻す（アカウント作成に失敗したときの取り消し）
CREATE OR REPLACE FUNCTION public.release_invite(invite_token UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.group_invites
     SET used_at = NULL
   WHERE token = invite_token AND used_by IS NULL;
$$;

-- 招待を使い切る（アカウント作成の後）。メンバー登録もここで行う。
CREATE OR REPLACE FUNCTION public.redeem_invite(invite_token UUID, new_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target_group UUID;
BEGIN
  SELECT group_id INTO target_group
    FROM public.group_invites WHERE token = invite_token AND used_by IS NULL;
  IF target_group IS NULL THEN
    RAISE EXCEPTION '招待が見つかりません' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (target_group, new_user, 'member')
  ON CONFLICT (group_id, user_id) DO NOTHING;

  UPDATE public.group_invites
     SET used_by = new_user, used_at = COALESCE(used_at, NOW())
   WHERE token = invite_token;
END;
$$;

-- これらは service_role（Edge Function）専用。ブラウザからは呼ばせない。
REVOKE ALL ON FUNCTION public.peek_invite(UUID)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_invite(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_invite(UUID)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_invite(UUID, UUID)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.peek_invite(UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_invite(UUID)         TO service_role;
GRANT EXECUTE ON FUNCTION public.release_invite(UUID)       TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_invite(UUID, UUID)  TO service_role;

-- ------------------------------------------------------------
-- ⑥ 人数上限はトリガーでも担保する（招待経由以外の追加に対する保険）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_group_size()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.group_members WHERE group_id = NEW.group_id)
     > public.group_member_limit() THEN
    RAISE EXCEPTION 'グループの人数上限（%人）を超えています', public.group_member_limit()
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_group_member_added ON public.group_members;
CREATE TRIGGER on_group_member_added
  AFTER INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_group_size();

COMMIT;
