-- ============================================================
-- 釣果に「ルアーの種別」を持たせる
--
-- 要望（2026-08-08）: レシピを選ばずカテゴリだけ記録したい。
--   レシピを選んだときは、そのレシピのカテゴリが自動で入るようにする。
--
-- なぜ recipe_id からの導出で済ませないか:
--   1. **レシピを登録していないルアーでも記録したい**のが今回の要望そのもの。
--      借りたルアー・買ったばかりのもの・人からもらったものは
--      レシピ化する前に釣れてしまう。
--   2. 釣果は「そのとき何を投げていたか」の記録なので、あとでレシピを
--      編集・削除しても当時の種別は変わらないほうがよい
--      （fish_name_local を実名で持っているのと同じ考え方）。
--
-- 大分類は lure_recipes.category_large と同じ 6 種に固定する。
-- 小分類は自由文字列（レシピ側も CHECK していないため揃える）。
-- ============================================================

BEGIN;

ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS lure_category_large TEXT,
  ADD COLUMN IF NOT EXISTS lure_category_small TEXT;

ALTER TABLE public.fishing_records
  DROP CONSTRAINT IF EXISTS fishing_records_lure_category_large_check;
ALTER TABLE public.fishing_records ADD CONSTRAINT fishing_records_lure_category_large_check CHECK (
  lure_category_large IS NULL OR lure_category_large IN (
    'area',    -- エリア
    'hard',    -- ハード（ミノー・シンペン・バイブ など）
    'metal',   -- メタル（ジグ・ジグヘッド など）
    'soft',    -- ソフト（ワーム など）
    'egi',     -- エギ
    'other'    -- その他
  )
);

-- 小分類だけあって大分類が無い状態は分析で扱いに困るので作らせない
ALTER TABLE public.fishing_records
  DROP CONSTRAINT IF EXISTS fishing_records_lure_category_pair_check;
ALTER TABLE public.fishing_records ADD CONSTRAINT fishing_records_lure_category_pair_check CHECK (
  lure_category_small IS NULL OR lure_category_large IS NOT NULL
);

COMMENT ON COLUMN public.fishing_records.lure_category_large IS
  'ルアー大分類。レシピを選んだ場合はそのレシピの値が入る（釣行時点の記録として保存する）。';
COMMENT ON COLUMN public.fishing_records.lure_category_small IS
  'ルアー小分類（ミノー・ジグ など）。大分類が無いときは NULL。';

-- 共有ビューにも載せる（他人の釣果でも種別は見えてよい）。
-- CREATE OR REPLACE では列を途中に足せない（列名の変更とみなされる）ので作り直す
DROP VIEW IF EXISTS public.record_feed;
CREATE VIEW public.record_feed
WITH (security_invoker = false) AS
SELECT
  r.id, r.user_id, r.user_id = auth.uid() AS is_mine,
  public.display_name(p.username) AS owner_name,
  r.fished_at, r.fished_time, r.is_skunked,
  r.fish_species_id,
  COALESCE(r.fish_name_local, fs.name) AS fish_label,
  fs.name AS species_name, r.fish_name_local,
  r.length_cm, r.weight_g, r.catch_count, r.quantity_note,
  r.tide_type, r.tide_snapshot, r.water_layer,
  r.rod, r.reel, r.line, r.leader, r.memo, r.visibility, r.created_at,
  r.spot_id, s.name AS spot_name, s.water_type AS spot_water_type,
  s.latitude AS spot_latitude, s.longitude AS spot_longitude,
  s.tide_station_code AS spot_tide_station_code,
  s.tide_area_code AS spot_tide_area_code,
  r.recipe_id, lr.name AS recipe_name,
  r.lure_category_large, r.lure_category_small,
  ph.thumb_path AS photo_thumb_path, ph.total AS photo_count
FROM public.fishing_records r
JOIN public.profiles p ON p.id = r.user_id
LEFT JOIN public.spots s ON s.id = r.spot_id
LEFT JOIN public.fish_species fs ON fs.id = r.fish_species_id
LEFT JOIN public.lure_recipes lr ON lr.id = r.recipe_id
LEFT JOIN LATERAL (
  SELECT first_value(rp.thumb_path) OVER (ORDER BY rp.sort_order, rp.created_at) AS thumb_path,
         count(*) OVER () AS total
  FROM public.record_photos rp
  WHERE rp.record_id = r.id
  LIMIT 1
) ph ON true
WHERE r.user_id = auth.uid()
   OR (r.visibility = 'group' AND public.shares_group_with(r.user_id));

GRANT SELECT ON public.record_feed TO authenticated;

-- 既存の釣果は、レシピが紐づいているものだけ種別を埋めておく
-- （手で入れ直させないため。レシピ無しのものは NULL のまま）
UPDATE public.fishing_records r
SET lure_category_large = lr.category_large,
    lure_category_small = lr.category_small
FROM public.lure_recipes lr
WHERE lr.id = r.recipe_id
  AND r.lure_category_large IS NULL
  AND lr.category_large IS NOT NULL;

COMMIT;
