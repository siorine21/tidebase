-- ============================================================
-- 共有する釣果にスポットの座標も含める
--
-- 010 では「どこで釣れたかは名前まで、座標は渡さない」という既定にしたが、
-- 実際に共有したいのは釣り場そのものだった（ユーザー判断 2026-08-07）。
-- record_feed に緯度経度を足し、共有された釣果から地図・経路案内を開けるようにする。
--
-- 出す行の条件は 010 のまま（自分の全件 + 同じグループの人の公開釣果）。
-- 見せたくない釣果を「自分のみ」にすればスポットも共有されない、という
-- 逃げ道も変わらない。
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.record_feed;

CREATE VIEW public.record_feed WITH (security_invoker = false) AS
SELECT
  r.id,
  r.user_id,
  (r.user_id = auth.uid())          AS is_mine,
  public.display_name(p.username)   AS owner_name,
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
  s.latitude                        AS spot_latitude,
  s.longitude                       AS spot_longitude,
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
  '釣果の読み取り用。自分の全件 + 同じグループの公開釣果（スポットの座標を含む）。書き込みは fishing_records へ。';

REVOKE ALL ON public.record_feed FROM PUBLIC;
REVOKE ALL ON public.record_feed FROM anon;
GRANT SELECT ON public.record_feed TO authenticated;

COMMIT;
