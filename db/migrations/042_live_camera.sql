-- ============================================================
-- スポットにライブ映像（YouTube）の動画 ID を持たせる
--
-- 波の予報は沖の推算値で、岸で見える波ではない（D-142）。
-- 「実際どうか」はカメラを見るのがいちばん早い。
--
-- **URL ではなく 11 桁の動画 ID だけを持つ。**
-- スポットはグループへ共有できるので、誰かが入れた URL を他の人の画面が
-- iframe で開くことになる。URL のまま持つと、そこが注入の口になる。
-- 画面側でも parseYouTubeId で ID だけを取り出しているが、
-- **境界は DB に置く**（画面を直すのを忘れても、ここで止まる）。
--
-- 地点ごとに人が入れる。どのカメラがどの浜を映しているかは
-- 座標からは決められないし、勝手に推測すると外したときに気づけない。
-- ============================================================

BEGIN;

ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS live_camera_youtube_id TEXT;

ALTER TABLE public.spots
  DROP CONSTRAINT IF EXISTS spots_live_camera_youtube_id_check;
ALTER TABLE public.spots
  ADD CONSTRAINT spots_live_camera_youtube_id_check
  CHECK (live_camera_youtube_id IS NULL
         OR live_camera_youtube_id ~ '^[A-Za-z0-9_-]{11}$');

-- ------------------------------------------------------------
-- spot_feed に足す。
-- **CREATE OR REPLACE で、列は必ず末尾に足す**（D-124）。
-- DROP VIEW → CREATE VIEW で作り直すと ACL が既定に戻り、
-- anon に ALL が付き直す。010 と 033 で実際にそれをやって穴を開けている。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.spot_feed AS
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
    s.tide_influence,
    s.live_camera_youtube_id
   FROM spots s
     JOIN profiles p ON p.id = s.user_id
  WHERE s.user_id = auth.uid() OR shares_group_with(s.user_id);

COMMIT;
