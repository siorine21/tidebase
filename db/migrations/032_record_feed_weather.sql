-- ============================================================
-- 釣果一覧のビューに weather_snapshot を足す
--
-- 列そのものは 003 からあるが、**ずっと NULL のままだった**。
-- 画面から入れる手立てが無く、ビューにも出していなかったため。
-- D-103 で記録時に残すようにしたので、読めるようにする。
--
-- 天気は tide_snapshot と違って **DB では埋められない**（外の API が要る）。
-- だから記録した時点でクライアントが入れる。あとから取り直せないので、
-- 入っていない過去の記録は入っていないまま。埋め戻しはしない
-- （推定値を本物と同じ場所に置くと、あとで区別が付かなくなる）。
--
-- 列は tide_snapshot のとなりに置く。security_invoker = false のままにすること。
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.record_feed;
CREATE VIEW public.record_feed
WITH (security_invoker = false) AS
SELECT r.id,
       r.user_id,
       r.user_id = auth.uid() AS is_mine,
       display_name(p.username) AS owner_name,
       r.fished_at,
       r.fished_time,
       r.outcome,
       r.is_skunked,
       r.fish_species_id,
       COALESCE(r.fish_name_local, fs.name) AS fish_label,
       fs.name AS species_name,
       r.fish_name_local,
       r.length_cm,
       r.weight_g,
       r.catch_count,
       r.quantity_note,
       r.tide_type,
       r.tide_snapshot,
       r.weather_snapshot,
       r.water_layer,
       r.rod,
       r.reel,
       r.line,
       r.leader,
       r.memo,
       r.visibility,
       r.created_at,
       r.spot_id,
       s.name AS spot_name,
       s.spot_type AS spot_spot_type,
       s.entry_style AS spot_entry_style,
       s.water_type AS spot_water_type,
       s.latitude AS spot_latitude,
       s.longitude AS spot_longitude,
       s.tide_station_code AS spot_tide_station_code,
       s.tide_area_code AS spot_tide_area_code,
       r.recipe_id,
       lr.name AS recipe_name,
       r.lure_name,
       COALESCE(lr.name, r.lure_name) AS lure_label,
       r.lure_category_large,
       r.lure_category_small,
       ph.thumb_path AS photo_thumb_path,
       ph.total AS photo_count
  FROM fishing_records r
  JOIN profiles p ON p.id = r.user_id
  LEFT JOIN spots s ON s.id = r.spot_id
  LEFT JOIN fish_species fs ON fs.id = r.fish_species_id
  LEFT JOIN lure_recipes lr ON lr.id = r.recipe_id
  LEFT JOIN LATERAL (
         SELECT first_value(rp.thumb_path)
                  OVER (ORDER BY rp.sort_order, rp.created_at) AS thumb_path,
                count(*) OVER () AS total
           FROM record_photos rp
          WHERE rp.record_id = r.id
          LIMIT 1) ph ON true
 WHERE r.user_id = auth.uid()
    OR (r.visibility = 'group' AND shares_group_with(r.user_id));

GRANT SELECT ON public.record_feed TO authenticated;

COMMENT ON VIEW public.record_feed IS
  '釣果一覧。自分の分と、グループへ公開された分だけを返す。'
  'security_invoker = false なので、この WHERE 句が境界そのもの。';

COMMENT ON COLUMN public.fishing_records.weather_snapshot IS
  '釣行時刻の天気。記録した時点でクライアントが入れる（D-103）。'
  'あとから取り直せない（予報 API は過去 3 か月まで）ので、'
  '入っていない過去の記録は NULL のまま。埋め戻さないこと。';

COMMIT;
