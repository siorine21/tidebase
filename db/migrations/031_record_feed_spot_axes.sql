-- ============================================================
-- 釣果一覧のビューに、スポットの「場所の種類」と「立ち位置」を足す
--
-- 傾向を見る画面（SCR-018）で「どんな場所で出ているか」を数えるため。
-- 釣果側にスポット ID はあるが、種類まで引くには釣果 1 件ごとに
-- スポットを引き直すことになる。ビューで結合しておけば 1 往復で済む。
--
-- **当時の値ではなく、いまのスポットの値**を出す。釣果の他の項目（ロッド名や
-- ルアー名）は当時の文字列を写しているが（D-058）、ここは写さない。
-- 場所の性格は釣行のたびに変わるものではなく、あとで直したときは
-- **過去の釣行にも遡って直っていてほしい**（実際 029→030 で直した）。
-- 写していたら、直す前の記録だけ古い種別のまま残ってしまう。
--
-- 列は spot_name のとなりに置く。security_invoker = false のままにすること。
-- WHERE 句が境界そのもの（010）。
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

COMMIT;
