-- ============================================================
-- 自分のタックルを登録しておき、釣果入力で選べるようにする
--
-- 要望（2026-08-09）: ロッド・リール・ライン・リーダーを毎回打ち込むのが手間。
--
-- なぜ 1 テーブルに種別を持たせるか（rods / reels / … と分けないか）:
--   4 つとも「名前だけの一覧」で、扱いも画面もまったく同じ。
--   分けると同じコードが 4 本になり、種別が増えるたびにテーブルが増える。
--
-- 釣果側は今までどおり**文字列で持つ**（rod / reel / line / leader）。
--   - 借りた竿・買ったばかりのものを、登録しないまま記録できる
--   - あとで登録名を変えても、当時の記録は変わらない
--     （釣果はそのときの事実の記録。lure_category_large と同じ考え方・D-058）
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.tackle_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('rod', 'reel', 'line', 'leader')),
  name       TEXT NOT NULL CHECK (btrim(name) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, name)
);

COMMENT ON TABLE public.tackle_items IS
  '自分のタックル（D-066）。釣果入力の候補として使う。釣果側は文字列で持つ。';

CREATE INDEX IF NOT EXISTS tackle_items_user_kind_idx
  ON public.tackle_items (user_id, kind, name);

ALTER TABLE public.tackle_items ENABLE ROW LEVEL SECURITY;

-- 自分のものだけ。共有しない（人の道具立てを勝手に見せない）
DROP POLICY IF EXISTS "tackle_items: own" ON public.tackle_items;
CREATE POLICY "tackle_items: own" ON public.tackle_items
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tackle_items TO authenticated;

-- これまでの釣果に入力済みのものを取り込む。
-- 一度打ち込んだものを登録し直させる理由がない
INSERT INTO public.tackle_items (user_id, kind, name)
SELECT DISTINCT r.user_id, k.kind, btrim(k.name)
FROM public.fishing_records r
CROSS JOIN LATERAL (VALUES
  ('rod', r.rod), ('reel', r.reel), ('line', r.line), ('leader', r.leader)
) AS k(kind, name)
WHERE k.name IS NOT NULL AND btrim(k.name) <> ''
ON CONFLICT (user_id, kind, name) DO NOTHING;

COMMIT;
