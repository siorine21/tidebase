-- ============================================================
-- 035: 消し損ねた実体を記録する（D-125）
--
-- 写真は「実体（Storage）」と「台帳（record_photos）」の 2 つで持っている。
-- 上げる途中で失敗したときは実体を消して巻き戻すが、その巻き戻しが
-- **失敗しても握りつぶしていた**（app.js の 2 か所）:
--
--   await storage.remove([path, thumbPath]).catch(() => {});
--
-- こうなると台帳に載っていない実体が残る。台帳に無い実体は
-- photo_visible_to_me が false を返すので、**持ち主本人からも見えない**。
-- 誰からも辿れないまま無料枠（1GB）を食い続け、しかも増えたことに気づけない。
--
-- **消せなかったパスをここに書き留めて、次に写真を触るときに掃き出す。**
-- 画面には出さない（使う人には直しようが無い）。
--
-- 意図的に「ログの表」ではなく「やり残しの表」にしてある。
-- 掃除が済んだ行は消えるので、**放っておいても太らない**（ローテーション不要）。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.orphan_objects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket        TEXT NOT NULL,
  path          TEXT NOT NULL,
  -- なぜ残ったか。増やすときは画面側と合わせること
  reason        TEXT NOT NULL CHECK (reason IN ('upload_rollback', 'delete_failed')),
  detail        TEXT,                          -- エラーの要旨（短く。秘密は入れない）
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tried_at TIMESTAMPTZ,
  UNIQUE (bucket, path)
);

COMMENT ON TABLE public.orphan_objects IS
  '消し損ねた Storage の実体。次に写真を触ったときに掃き出し、消えた行は削除する（035）。';
COMMENT ON COLUMN public.orphan_objects.attempts IS
  '掃き出しを試した回数。増え続ける行は、通信ではなく作りの問題を疑う。';

-- 自分の行だけ。**掃き出しに UPDATE / DELETE も要る**ので ALL にする
ALTER TABLE public.orphan_objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orphan_objects: own" ON public.orphan_objects;
CREATE POLICY "orphan_objects: own" ON public.orphan_objects
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ログインしている人だけ。anon には触らせない（033 と同じ方針）
REVOKE ALL ON public.orphan_objects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orphan_objects TO authenticated;
