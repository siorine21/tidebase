-- ============================================================
-- 釣果のルアーを、レシピを選ばずに名前だけでも残せるようにする
--
-- 要望（2026-08-09）: 釣果のルアー入力も、タックルと同じように
--   自由入力できるようにしてほしい。
--
-- いまはレシピ（lure_recipes）を選ぶしかない。だが実際には
--   ・借りたルアー、もらったルアー
--   ・その日かぎりで、レシピとして登録するほどでもないもの
--   ・釣行中に名前だけ控えておきたいとき
-- がある。ロッドやリールを **文字列で持っている**（D-066）のと同じ理由で、
-- ルアーにも「登録していないものを書ける逃げ道」が要る。
--
-- 列を分ける（recipe_id と lure_name の 2 本立てにする）理由:
--   レシピを選んだときは **id で結びたい**。あとでレシピ名を直したら
--   過去の釣果の表示も追従してほしいし、レシピごとの釣果数も数えたい。
--   一方、自由入力は結びつく先が無いので文字列で置くしかない。
--   1 つの列に混ぜると、どちらの意味なのか判別できなくなる。
--
-- 両方入ることは無い（CHECK で防ぐ）。入ってしまうと、
-- 画面がどちらを出すべきか決められない。
-- ============================================================

BEGIN;

ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS lure_name TEXT;

COMMENT ON COLUMN public.fishing_records.lure_name IS
  'レシピに登録していないルアーの名前（自由入力）。recipe_id とは排他。';

-- 空文字は NULL と同じ意味なので、入り口で潰しておく（判定を 1 種類にする）
UPDATE public.fishing_records SET lure_name = NULL WHERE btrim(lure_name) = '';

ALTER TABLE public.fishing_records
  DROP CONSTRAINT IF EXISTS fishing_records_lure_source_check;
ALTER TABLE public.fishing_records
  ADD CONSTRAINT fishing_records_lure_source_check
  CHECK (recipe_id IS NULL OR lure_name IS NULL);

-- ------------------------------------------------------------
-- 一覧のビューにも出す。
-- 画面ごとに COALESCE を書くと、片方だけ直し忘れて
-- 「一覧には出るのに詳細には出ない」が起きる。ビューで 1 本にする。
-- CREATE OR REPLACE は列を途中に足せないので、作り直す。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.record_feed;

CREATE VIEW public.record_feed
WITH (security_invoker = false) AS
SELECT r.id,
    r.user_id,
    r.user_id = auth.uid() AS is_mine,
    display_name(p.username) AS owner_name,
    r.fished_at,
    r.fished_time,
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
    s.water_type AS spot_water_type,
    s.latitude AS spot_latitude,
    s.longitude AS spot_longitude,
    s.tide_station_code AS spot_tide_station_code,
    s.tide_area_code AS spot_tide_area_code,
    r.recipe_id,
    lr.name AS recipe_name,
    r.lure_name,
    -- 画面が見るのはこれ 1 つ。レシピを選んでいればその名前、
    -- 自由入力ならその文字列。どちらでもなければ NULL
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
     LEFT JOIN LATERAL ( SELECT first_value(rp.thumb_path) OVER (ORDER BY rp.sort_order, rp.created_at) AS thumb_path,
            count(*) OVER () AS total
           FROM record_photos rp
          WHERE rp.record_id = r.id
         LIMIT 1) ph ON true
  WHERE r.user_id = auth.uid() OR r.visibility = 'group'::text AND shares_group_with(r.user_id);

COMMENT ON VIEW public.record_feed IS
  '釣果の一覧。security_invoker = false なので、WHERE 句が見える範囲の境界そのもの。'
  '自分の釣果と、同じグループの人が group 公開にした釣果だけを返す。';

REVOKE ALL ON public.record_feed FROM PUBLIC;
GRANT SELECT ON public.record_feed TO authenticated;

COMMIT;
