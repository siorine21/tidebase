-- ============================================================
-- 仲間内のバトル（釣果の勝負）と、「この日行きたい」のカレンダー
--
-- 本人の言葉:「たまに仲間内でバトルをするときがある。例えば何日何時〜何日何時の間、
-- 釣ったシーバスの合計の長さで勝負や、シンプルに一番大きいシーバスを釣ったらなど。
-- 勝負内容を調整が利くカタチで、集計できるような機能が欲しい。
-- 証拠として釣果に写真付きでアップロードすることを条件とする。」
-- 「さらにこの日この時間に釣りに行きたい！のように意思表示できるカレンダーが欲しい」
--
-- 決めたこと（本人に確認済み）:
--   - ルールは **集計方法 × 対象魚種** の 2 つだけ。式は書かせない
--   - 数えるのは **参加表明した人だけ**。押していない人の釣果は集計に入らない
--   - カレンダーは日付と時間帯を**選択式**で選び、一言を添える。挙手で乗る
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- バトル
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.battles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),

  /* **期間は日本時間の壁時計で持つ。**
     釣果は fished_at（日付）と fished_time（時刻）を JST の壁時計として持っており、
     時差を持っていない。ここだけ timestamptz にすると、
     境目の 1 時間が国をまたいだときだけずれる、という一番気づけない壊れ方をする。
     **同じ土俵で比べる。** 表示も入力も JST しかない（静岡県の釣りアプリなので）。 */
  starts_at   TIMESTAMP NOT NULL,
  ends_at     TIMESTAMP NOT NULL,
  CHECK (ends_at > starts_at),

  -- 集計方法。式は書かせない（3 つから選ぶ）
  --   total_length … 合計の長さ / max_length … いちばん大きい 1 匹 / count … 匹数
  metric      TEXT NOT NULL CHECK (metric IN ('total_length', 'max_length', 'count')),

  /* **写真は既定で要る**（本人の言う「証拠」）。
     ただしバトルごとに外せるようにする。身内の遊びなので、
     「今日は写真なしでいいよ」と決められるほうが実際に使える */
  require_photo BOOLEAN NOT NULL DEFAULT TRUE,

  note        TEXT CHECK (note IS NULL OR length(note) <= 400),
  created_by  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS battles_group_idx ON public.battles (group_id, starts_at DESC);

-- 対象魚種。**1 行も無ければ「魚種の指定なし」**（全部数える）
CREATE TABLE IF NOT EXISTS public.battle_species (
  battle_id       UUID NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  fish_species_id UUID NOT NULL REFERENCES public.fish_species(id) ON DELETE CASCADE,
  PRIMARY KEY (battle_id, fish_species_id)
);

-- 参加表明。**押した人だけが順位に載る**
CREATE TABLE IF NOT EXISTS public.battle_entries (
  battle_id UUID NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, user_id)
);

-- ------------------------------------------------------------
-- 「この日この時間に行きたい」
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fishing_plans (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_date  DATE NOT NULL,

  /* **時間帯は選択式**（本人の要望）。0〜24 の時で持つ。
     終わりに 24 を許すのは「22 時〜24 時」を書けるようにするため。
     日をまたぐ夜釣りは翌日の「0 時〜4 時」として書く。
     **分は持たない。** 予定を合わせるのに 15 分の精度は要らず、
     選ぶ手間だけが増える */
  start_hour SMALLINT NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  end_hour   SMALLINT NOT NULL CHECK (end_hour   BETWEEN 1 AND 24),
  CHECK (end_hour > start_hour),

  spot_id    UUID REFERENCES public.spots(id) ON DELETE SET NULL,
  note       TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fishing_plans_group_date_idx
  ON public.fishing_plans (group_id, plan_date);

-- 挙手。**「自分も行く」だけ。** 賛成・不参加のような細かい区別は持たない
CREATE TABLE IF NOT EXISTS public.plan_hands (
  plan_id    UUID NOT NULL REFERENCES public.fishing_plans(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id)
);

-- ------------------------------------------------------------
-- RLS
--
-- **境界はグループ。** どれも「そのグループの一員か」で決まる。
-- is_group_member は SECURITY DEFINER の補助関数（ポリシーの中から
-- 別の保護テーブルを直接見ない・CLAUDE.md）。
-- ------------------------------------------------------------
ALTER TABLE public.battles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.battle_species ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.battle_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fishing_plans  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_hands     ENABLE ROW LEVEL SECURITY;

-- バトル: 読むのはグループの一員。作れるのも一員。直す・消すのは**作った人だけ**
DROP POLICY IF EXISTS battles_read   ON public.battles;
DROP POLICY IF EXISTS battles_insert ON public.battles;
DROP POLICY IF EXISTS battles_update ON public.battles;
DROP POLICY IF EXISTS battles_delete ON public.battles;
CREATE POLICY battles_read ON public.battles
  FOR SELECT TO authenticated USING (is_group_member(group_id));
CREATE POLICY battles_insert ON public.battles
  FOR INSERT TO authenticated
  WITH CHECK (is_group_member(group_id) AND created_by = auth.uid());
CREATE POLICY battles_update ON public.battles
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
CREATE POLICY battles_delete ON public.battles
  FOR DELETE TO authenticated USING (created_by = auth.uid());

-- 対象魚種: バトルに付いて回る。**バトルを作った人だけが触れる**
DROP POLICY IF EXISTS battle_species_read  ON public.battle_species;
DROP POLICY IF EXISTS battle_species_write ON public.battle_species;
CREATE POLICY battle_species_read ON public.battle_species
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.battles b
            WHERE b.id = battle_id AND is_group_member(b.group_id)));
CREATE POLICY battle_species_write ON public.battle_species
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.battles b
                 WHERE b.id = battle_id AND b.created_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.battles b
                      WHERE b.id = battle_id AND b.created_by = auth.uid()));

-- 参加表明: 見るのは一員。**出る・降りるは自分のぶんだけ**
DROP POLICY IF EXISTS battle_entries_read  ON public.battle_entries;
DROP POLICY IF EXISTS battle_entries_join  ON public.battle_entries;
DROP POLICY IF EXISTS battle_entries_leave ON public.battle_entries;
CREATE POLICY battle_entries_read ON public.battle_entries
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.battles b
            WHERE b.id = battle_id AND is_group_member(b.group_id)));
CREATE POLICY battle_entries_join ON public.battle_entries
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.battles b
                WHERE b.id = battle_id AND is_group_member(b.group_id)));
CREATE POLICY battle_entries_leave ON public.battle_entries
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- 予定: 読むのは一員。**書けるのは自分のぶんだけ**
DROP POLICY IF EXISTS fishing_plans_read   ON public.fishing_plans;
DROP POLICY IF EXISTS fishing_plans_insert ON public.fishing_plans;
DROP POLICY IF EXISTS fishing_plans_update ON public.fishing_plans;
DROP POLICY IF EXISTS fishing_plans_delete ON public.fishing_plans;
CREATE POLICY fishing_plans_read ON public.fishing_plans
  FOR SELECT TO authenticated USING (is_group_member(group_id));
CREATE POLICY fishing_plans_insert ON public.fishing_plans
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND is_group_member(group_id));
CREATE POLICY fishing_plans_update ON public.fishing_plans
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY fishing_plans_delete ON public.fishing_plans
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- 挙手: 見るのは一員。**上げ下げは自分のぶんだけ**
DROP POLICY IF EXISTS plan_hands_read ON public.plan_hands;
DROP POLICY IF EXISTS plan_hands_up   ON public.plan_hands;
DROP POLICY IF EXISTS plan_hands_down ON public.plan_hands;
CREATE POLICY plan_hands_read ON public.plan_hands
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.fishing_plans p
            WHERE p.id = plan_id AND is_group_member(p.group_id)));
CREATE POLICY plan_hands_up ON public.plan_hands
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.fishing_plans p
                WHERE p.id = plan_id AND is_group_member(p.group_id)));
CREATE POLICY plan_hands_down ON public.plan_hands
  FOR DELETE TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.battles, public.battle_species, public.battle_entries,
              public.fishing_plans, public.plan_hands
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.battles, public.fishing_plans TO authenticated;
GRANT SELECT, INSERT, DELETE
  ON public.battle_species, public.battle_entries, public.plan_hands TO authenticated;

-- 直した時刻を自分で持たせる（034 と同じ扱い）
DROP TRIGGER IF EXISTS battles_touch ON public.battles;
CREATE TRIGGER battles_touch BEFORE UPDATE ON public.battles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS fishing_plans_touch ON public.fishing_plans;
CREATE TRIGGER fishing_plans_touch BEFORE UPDATE ON public.fishing_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------
-- 集計
--
-- **1 本の関数にまとめる。** 順位を出す側と「なぜ数えなかったか」を出す側で
-- 条件が食い違うと、画面に「写真はあるのに数えられていない」が出て信用を失う。
-- 数えるかどうかを決めるのはここ 1 か所だけにする。
--
-- SECURITY DEFINER。中で**グループの一員かを必ず確かめる**。
-- 見えてよい釣果しか触らないよう、visibility = 'group' も条件に入れる
-- （自分だけの釣果は他の人が確かめられないので、勝負には数えない）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.battle_records(target_battle_id UUID)
RETURNS TABLE (
  record_id   UUID,
  user_id     UUID,
  owner_name  TEXT,
  fished_at   DATE,
  fished_time TIME,
  fish_label  TEXT,
  length_cm   NUMERIC,
  photo_count BIGINT,
  counted     BOOLEAN,
  reason      TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b public.battles%ROWTYPE;
  any_species BOOLEAN;
BEGIN
  SELECT * INTO b FROM public.battles WHERE id = target_battle_id;
  IF b.id IS NULL THEN
    RAISE EXCEPTION 'そのバトルはありません';
  END IF;
  -- **ここが境界。** 一員でなければ 1 行も返さない
  IF NOT is_group_member(b.group_id) THEN
    RAISE EXCEPTION 'このバトルを見る権限がありません';
  END IF;

  SELECT NOT EXISTS (SELECT 1 FROM public.battle_species WHERE battle_id = b.id)
    INTO any_species;

  RETURN QUERY
  SELECT
    r.id,
    r.user_id,
    display_name(p.username),
    r.fished_at,
    r.fished_time,
    COALESCE(r.fish_name_local, fs.name),
    r.length_cm,
    COALESCE(ph.n, 0),
    /* 数えるかどうか。**下の reason と裏表にする。**
       片方だけ直すと「理由は出ているのに数えられている」が起きる */
    (ph.n IS NOT NULL OR NOT b.require_photo)
      AND (b.metric = 'count' OR r.length_cm IS NOT NULL),
    CASE
      WHEN b.require_photo AND ph.n IS NULL THEN 'photo'
      WHEN b.metric <> 'count' AND r.length_cm IS NULL THEN 'length'
      ELSE NULL
    END
  FROM public.fishing_records r
  JOIN public.profiles p ON p.id = r.user_id
  JOIN public.battle_entries e ON e.battle_id = b.id AND e.user_id = r.user_id
  LEFT JOIN public.fish_species fs ON fs.id = r.fish_species_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM public.record_photos rp WHERE rp.record_id = r.id
    HAVING count(*) > 0
  ) ph ON TRUE
  WHERE
    -- **釣り上げたものだけ。** バラシもアタリも「釣った」ではない
    r.outcome = 'landed'
    -- 他の人が確かめられないものは勝負に持ち込まない
    AND r.visibility = 'group'
    /* **時刻が無いものは土俵に上げない。** 「何日何時〜何日何時」の勝負なので、
       時刻が無い釣果は期間の内か外かを決められない。
       ここで漏れたものは画面にも出ない（期間の外と同じ扱い） */
    AND r.fished_time IS NOT NULL
    AND (r.fished_at + r.fished_time) >= b.starts_at
    AND (r.fished_at + r.fished_time) <  b.ends_at
    AND (any_species OR EXISTS (
          SELECT 1 FROM public.battle_species bs
          WHERE bs.battle_id = b.id AND bs.fish_species_id = r.fish_species_id))
  ORDER BY r.fished_at, r.fished_time;
END;
$$;

REVOKE ALL ON FUNCTION public.battle_records(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.battle_records(UUID) TO authenticated;

COMMIT;
