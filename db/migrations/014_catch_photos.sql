-- ============================================================
-- 釣果写真（Supabase Storage）
--
-- 方針（D-045）: **原本は保存しない。表示用のコピーだけを持つ。**
--   原本はスマホのカメラロールにある。アプリが二重に持つ意味は薄く、
--   無料枠 1GB は原寸（3〜5MB）だと 1 年もたない。
--   ブラウザ側で長辺 1600px の WebP に縮小してから上げる（約 200KB）。
--
-- バケットは **非公開**にする。招待制でここまで作ってきた共有の作り
-- （D-041 / D-043）に対して、URL を知っていれば誰でも見られる公開バケットは
-- 明らかな弱点になる。閲覧は署名付き URL 経由で、その発行時に RLS が効く。
--
-- パスの規約: <user_id>/<photo_id>.webp / <user_id>/<photo_id>_t.webp
--   先頭が必ず所有者の user_id なので、書き込み権限を
--   storage.foldername(name)[1] = auth.uid() だけで表現できる。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- ① バケット
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('catch-photos', 'catch-photos', FALSE, 3145728,
        ARRAY['image/webp', 'image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = FALSE,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3MB 上限。縮小後は 200KB 前後なので通常は遠く及ばないが、
-- 縮小に失敗した経路で原寸が入るのを防ぐ歯止めとして置く。

-- ------------------------------------------------------------
-- ② 写真の台帳
--    Storage 側だけだと「どの釣果の何枚目か」「並び順」が持てず、
--    釣果を消したときに何を消せばよいかも分からない。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.record_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   UUID NOT NULL REFERENCES public.fishing_records(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,   -- 表示用（長辺 1600px）
  thumb_path  TEXT NOT NULL UNIQUE,   -- 一覧用（長辺 400px）
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS record_photos_record_idx
  ON public.record_photos (record_id, sort_order);

COMMENT ON TABLE public.record_photos IS
  '釣果写真の台帳。実体は Storage の catch-photos バケット（非公開）。';

ALTER TABLE public.record_photos ENABLE ROW LEVEL SECURITY;

-- その釣果が自分に見えるか。**SECURITY DEFINER でなければならない。**
-- ポリシーの中から素の副問い合わせで fishing_records を引くと、そちらにも
-- RLS（自分の行だけ）が効いてしまい、共有された釣果が常に 0 件になる。
CREATE OR REPLACE FUNCTION public.record_visible_to_me(target_record_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fishing_records r
     WHERE r.id = target_record_id
       AND (r.user_id = auth.uid()
         OR (r.visibility = 'group' AND public.shares_group_with(r.user_id)))
  );
$$;

COMMENT ON FUNCTION public.record_visible_to_me(UUID) IS
  'record_feed と同じ可視条件。ポリシーの中から釣果を参照するときに使う。';

-- 自分の写真は全部、他人のものは「共有された釣果に紐づくもの」だけ読める。
-- 条件は record_feed と同じにする（釣果が見えるなら、その写真も見える）。
DROP POLICY IF EXISTS "record_photos: read" ON public.record_photos;
CREATE POLICY "record_photos: read" ON public.record_photos
  FOR SELECT USING (
    user_id = auth.uid() OR public.record_visible_to_me(record_id)
  );

-- 書き込みは自分の釣果に対してだけ。他人の釣果に写真をぶら下げられない。
DROP POLICY IF EXISTS "record_photos: write own" ON public.record_photos;
CREATE POLICY "record_photos: write own" ON public.record_photos
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.fishing_records r
       WHERE r.id = record_photos.record_id AND r.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- ③ Storage の権限
--    署名付き URL を作る時点で SELECT が評価される。ここが認可の実体。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.photo_visible_to_me(object_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.record_photos p
     WHERE (p.path = object_path OR p.thumb_path = object_path)
       AND public.record_visible_to_me(p.record_id)
  );
$$;

COMMENT ON FUNCTION public.photo_visible_to_me(TEXT) IS
  '署名付き URL の発行可否。台帳を引いて、その釣果が見えるかどうかで決める。';

DROP POLICY IF EXISTS "catch-photos: read" ON storage.objects;
CREATE POLICY "catch-photos: read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'catch-photos'
    AND (
      (storage.foldername(name))[1] = auth.uid()::TEXT
      OR public.photo_visible_to_me(name)
    )
  );

-- 書き込み・削除は自分のフォルダだけ。台帳より先にオブジェクトを置くので、
-- ここは台帳を参照せずパスの先頭だけで判断する。
DROP POLICY IF EXISTS "catch-photos: write own" ON storage.objects;
CREATE POLICY "catch-photos: write own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'catch-photos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

DROP POLICY IF EXISTS "catch-photos: update own" ON storage.objects;
CREATE POLICY "catch-photos: update own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'catch-photos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

DROP POLICY IF EXISTS "catch-photos: delete own" ON storage.objects;
CREATE POLICY "catch-photos: delete own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'catch-photos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

-- ------------------------------------------------------------
-- ④ record_feed に 1 枚目のサムネイルを足す
--    一覧で写真を出すのに、釣果 1 件ごとに問い合わせを増やしたくない。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.record_feed;

CREATE VIEW public.record_feed WITH (security_invoker = false) AS
SELECT
  r.id,
  r.user_id,
  (r.user_id = auth.uid())          AS is_mine,
  public.display_name(p.username)   AS owner_name,
  r.fished_at,
  r.fished_time,
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
  s.latitude                        AS spot_latitude,
  s.longitude                       AS spot_longitude,
  s.tide_station_code               AS spot_tide_station_code,
  s.tide_area_code                  AS spot_tide_area_code,
  r.recipe_id,
  lr.name                           AS recipe_name,
  ph.thumb_path                     AS photo_thumb_path,
  ph.total                          AS photo_count
FROM public.fishing_records r
JOIN public.profiles p            ON p.id = r.user_id
LEFT JOIN public.spots s          ON s.id = r.spot_id
LEFT JOIN public.fish_species fs  ON fs.id = r.fish_species_id
LEFT JOIN public.lure_recipes lr  ON lr.id = r.recipe_id
LEFT JOIN LATERAL (
  SELECT first_value(rp.thumb_path) OVER (ORDER BY rp.sort_order, rp.created_at) AS thumb_path,
         COUNT(*) OVER () AS total
    FROM public.record_photos rp
   WHERE rp.record_id = r.id
   LIMIT 1
) ph ON TRUE
WHERE r.user_id = auth.uid()
   OR (r.visibility = 'group' AND public.shares_group_with(r.user_id));

COMMENT ON VIEW public.record_feed IS
  '釣果の読み取り用。自分の全件 + 同じグループの公開釣果。書き込みは fishing_records へ。';

REVOKE ALL ON public.record_feed FROM PUBLIC;
REVOKE ALL ON public.record_feed FROM anon;
GRANT SELECT ON public.record_feed TO authenticated;

COMMIT;
