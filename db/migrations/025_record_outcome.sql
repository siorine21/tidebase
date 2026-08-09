-- ============================================================
-- 釣果を「釣れた / ボウズ」の二択から、到達段階に変える
--
-- 要望（2026-08-10）: ミスバイトやバラシ、要するにターゲットがいたことを
--   確認したら、釣果ではないが登録したい。
--
-- いまは is_skunked（真偽値）しか無いので、バラシもミスバイトも
-- 「ボウズ」に落ちる。だが実際には段階がある:
--
--   landed   獲れた
--   lost     バラシ（掛けたが獲れなかった）
--   bite     ミスバイト（アタリはあったが乗らなかった）
--   sighting 目視のみ（ボイル・チェイス・魚影。ルアーには触れていない）
--   none     何も無し（いままでのボウズ）
--
-- **別テーブルにしない**理由:
--   バラシに残したい情報は釣果とまったく同じ（日時・スポット・潮位と天気の
--   スナップショット・ルアー・タックル）。別に持つと、この一式とそれを埋める
--   処理をもう 1 セット抱えることになる。一覧も 2 本に割れるし、
--   このアプリの目的である相関分析が union だらけになる。
--
-- **1 釣行に複数件**として残す（1 本獲って 2 回バラした → 3 件）。
--   その 1 回がどの潮位・どの時刻だったかを個別に持てる。
--   マヅメにバラして 2 時間後に獲れた、という違いが残る。
--   もともと (user, 日付, スポット) に一意制約は無いので、制約の変更は要らない。
--
-- is_skunked は残して同期させる。消すと、端末に古い画面が残っている間
-- （GitHub Pages は 10 分キャッシュ・D-088）に書き込みが落ちる。
-- 画面を全部移し終えてから、別のマイグレーションで落とす。
-- ============================================================

BEGIN;

ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS outcome TEXT;

COMMENT ON COLUMN public.fishing_records.outcome IS
  '到達段階: landed 獲れた / lost バラシ / bite ミスバイト / sighting 目視のみ / none 何も無し。'
  'is_skunked は outcome から決まる（同期トリガあり）。';

-- 既存の行を埋める。ボウズは none、それ以外は landed
UPDATE public.fishing_records
   SET outcome = CASE WHEN is_skunked THEN 'none' ELSE 'landed' END
 WHERE outcome IS NULL;

ALTER TABLE public.fishing_records
  DROP CONSTRAINT IF EXISTS fishing_records_outcome_check;
ALTER TABLE public.fishing_records
  ADD CONSTRAINT fishing_records_outcome_check
  CHECK (outcome IN ('landed', 'lost', 'bite', 'sighting', 'none'));

-- ------------------------------------------------------------
-- outcome と is_skunked の同期
--
-- 既定値を付けずトリガで埋める。既定値にしてしまうと、
-- **outcome を送ってこない古い画面**（is_skunked だけ送る）の insert が
-- 既定の landed になり、ボウズが釣果として入ってしまう。
-- NOT NULL は BEFORE トリガのあとに見られるので、ここで埋めれば通る。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_record_outcome()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.outcome IS NULL THEN
    -- outcome を知らない画面からの書き込み。is_skunked から決める
    NEW.outcome := CASE WHEN NEW.is_skunked THEN 'none' ELSE 'landed' END;
  ELSIF TG_OP = 'UPDATE' AND NEW.outcome = OLD.outcome
        AND NEW.is_skunked IS DISTINCT FROM OLD.is_skunked THEN
    -- 古い画面が is_skunked だけ書き換えた場合も拾う
    NEW.outcome := CASE WHEN NEW.is_skunked THEN 'none' ELSE 'landed' END;
  END IF;

  NEW.is_skunked := (NEW.outcome <> 'landed');

  -- 何も無しに匹数は無い。古い画面は既定の 1 を送ってくる
  IF NEW.outcome = 'none' THEN
    NEW.catch_count := 0;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_record_outcome ON public.fishing_records;
CREATE TRIGGER sync_record_outcome
  BEFORE INSERT OR UPDATE ON public.fishing_records
  FOR EACH ROW EXECUTE FUNCTION public.sync_record_outcome();

-- 既存のボウズの匹数も揃えておく（1 が入っていた）
UPDATE public.fishing_records SET catch_count = 0
 WHERE outcome = 'none' AND COALESCE(catch_count, 0) <> 0;

ALTER TABLE public.fishing_records
  ALTER COLUMN outcome SET NOT NULL;

-- ------------------------------------------------------------
-- 一覧のビューに outcome を足す
-- 列を途中に挟むので CREATE OR REPLACE は使えない（列の追加は末尾のみ）。
-- security_invoker = false のままにすること。WHERE 句が境界そのもの（010）。
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
    SELECT first_value(rp.thumb_path) OVER (ORDER BY rp.sort_order, rp.created_at) AS thumb_path,
           count(*) OVER () AS total
      FROM record_photos rp
     WHERE rp.record_id = r.id
     LIMIT 1) ph ON true
 WHERE r.user_id = auth.uid()
    OR (r.visibility = 'group' AND shares_group_with(r.user_id));

GRANT SELECT ON public.record_feed TO authenticated;

COMMENT ON VIEW public.record_feed IS
  '釣果一覧。自分の分と、グループで共有された分だけを返す。'
  'security_invoker = false なので、この WHERE 句が境界そのもの。';

COMMIT;
