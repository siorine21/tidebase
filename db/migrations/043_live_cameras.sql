-- ============================================================
-- ライブカメラを「スポットの持ち物」から「地域のもの」に作り直す
--
-- 042 でスポットに live_camera_youtube_id を持たせたが、**使い方を取り違えていた。**
-- 本人の言葉:「釣りに行くとき、まずは海の様子をチェックする。この辺りで唯一ある
-- 同笠海岸のライブカメラをダッシュボードに置きたい。もう一つ置くとしたら浜名湖」。
--
-- つまりカメラは **行き先を決める前に見るもの**で、選んでいるスポットとは無関係。
-- スポットに紐づけると、河川のスポットを選んでいる間は出てこない。
-- 海の様子を見てから行き先を決めるのだから、順序が逆になっていた。
--
-- そもそも「この辺りで唯一ある」ので、27 件のスポットのうち 26 件で
-- 空のままになる列だった。地域の master にするほうが実態に合う
-- （tide_stations / tide_areas と同じ持ち方）。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 地域のライブカメラ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.live_cameras (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- **URL ではなく 11 桁の動画 ID だけ**（D-143）。ここが iframe に入るので、
  -- 形を DB で縛る。画面側でも parseYouTubeId を通すが、境界は 2 枚にする
  youtube_id  TEXT NOT NULL CHECK (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  water_body  TEXT,                       -- 「遠州灘」「浜名湖」など。見出しに使う
  pref        TEXT NOT NULL DEFAULT '静岡県',
  lat         NUMERIC,
  lng         NUMERIC,
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 誰が見ても同じ内容なので RLS は要らないが、**書けるのは postgres だけ**にする。
-- 読みは authenticated だけ（anon には出さない。他の feed と同じ扱い）
ALTER TABLE public.live_cameras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_cameras_read ON public.live_cameras;
CREATE POLICY live_cameras_read ON public.live_cameras
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.live_cameras FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.live_cameras TO authenticated;

INSERT INTO public.live_cameras (code, name, youtube_id, water_body, lat, lng, note, sort_order)
VALUES
  ('ENSHU-DOUGASA', '同笠海岸', 'kQljrmctUkg', '遠州灘', 34.6300, 137.9300,
   'この辺りで唯一の遠州灘のライブ映像。サーフの波っ気を見る', 10)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, youtube_id = EXCLUDED.youtube_id,
      water_body = EXCLUDED.water_body, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
      note = EXCLUDED.note, sort_order = EXCLUDED.sort_order;

-- ------------------------------------------------------------
-- 042 で足したスポットの列を戻す
--
-- **ここは DROP VIEW → CREATE VIEW になる。** CREATE OR REPLACE VIEW は
-- 列を足すことしかできず、減らせない。作り直すと ACL が既定に戻り、
-- anon に ALL が付き直す（D-124。010 / 016 / 025 / 031 / 032 で実際に起きた）。
-- **だから作り直したら必ず REVOKE / GRANT を書く。**
-- test_migrations.sql の先頭がこの権限を毎回検査している。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.spot_feed;

CREATE VIEW public.spot_feed AS
 SELECT s.id,
    s.user_id,
    s.user_id = auth.uid() AS is_mine,
    display_name(p.username) AS owner_name,
    s.name,
    s.spot_type,
    s.entry_style,
    s.water_type,
    s.latitude,
    s.longitude,
    s.tide_station_code,
    s.tide_area_code,
    s.low_tide_only,
    s.visibility,
    s.memo,
    s.created_at,
    s.tide_influence
   FROM spots s
     JOIN profiles p ON p.id = s.user_id
  WHERE s.user_id = auth.uid() OR shares_group_with(s.user_id);

REVOKE ALL ON public.spot_feed FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.spot_feed TO authenticated;

ALTER TABLE public.spots DROP COLUMN IF EXISTS live_camera_youtube_id;

COMMIT;
