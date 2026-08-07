-- ============================================================
-- 釣果に時刻を持たせる
--
-- 目的（ユーザー要望 2026-08-07）: 釣れた時間の潮位を知りたい。
--
-- 日付だけだと「大潮の日に釣れた」までしか分からない。時刻があれば
-- 「上げ 3 分で釣れた」「満潮前後だった」まで残せる。潮汐は推算値なので、
-- 時刻さえ分かれば潮位は後からいくらでも引き直せる。
--
-- NULL 可にする理由:
--   - 既存の記録には時刻が無い（後から思い出せないものを埋めさせない）
--   - 「その日行ったが時間は覚えていない」を記録できなくすると、
--     記録そのものを諦められてしまう
-- タイムゾーンを持たない TIME にする理由:
--   釣行日（fished_at）と組で JST の壁掛け時計の時刻として扱う。
--   D-011 のとおりアプリ全体が JST 固定なので、ここで tz を持つと
--   むしろ日付との整合が取りづらくなる。
-- ============================================================

BEGIN;

ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS fished_time TIME;

COMMENT ON COLUMN public.fishing_records.fished_time IS
  '釣れた時刻（JST の壁掛け時計。fished_at と組で読む）。不明なら NULL。';

-- ------------------------------------------------------------
-- record_feed に時刻とスポットの潮汐地点を足す。
-- 潮汐地点コードが要るのは、共有された釣果でも
-- 「そのスポットの潮位」を引けるようにするため
-- （基準観測点と時差が分からないと推算できない）。
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

REVOKE ALL ON public.record_feed FROM PUBLIC;
REVOKE ALL ON public.record_feed FROM anon;
GRANT SELECT ON public.record_feed TO authenticated;

COMMIT;
