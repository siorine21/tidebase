-- ============================================================
-- 釣果に「そのときの潮位置」（上げ7分・下げ3分…）を持たせる
--
-- 要望（2026-09-21）: 「時期の釣果も重要だが、同じような潮回り（上げ5分等）も
-- 重要な判断情報」。おすすめスポットが「いまと同じ潮位置で何回釣れたか」を
-- 言えるようにするための土台。
--
-- **いま何が入っていないか**
-- tide_snapshot に入っているのは {method, moon_age, tide_type} の 3 つだけで、
-- 潮位置は 66 件すべて入っていない。tide_type（大潮・中潮）は日付から決まる
-- 別の軸で、**その日のどこにいたか**は表していない。
--
-- **なぜ tide_snapshot の中に足さないか**
-- tide_snapshot は 004 のトリガー（normalize_fishing_record）が
-- **fished_at から丸ごと作り直す**もの。一方で潮位置を出すには
-- その日の毎時潮位が要り、それは JMA の推算値なので **DB には無い**
-- （tide の Edge Function がクライアントに返している）。
-- 同じ JSON に書き手が 2 人いると、片方が黙ってもう片方を消す。
-- 実際 023 は、まさにその取り違えを直した migration だった。
-- だから**別の列**にして、書き手を 1 人に保つ。
--
-- **なぜ日付・時刻を変えたら消すか**
-- 潮位置は fished_at と fished_time の両方から決まる。どちらかが変われば
-- 保存してある値は嘘になる。DB では計算し直せないので、**消す**。
-- 古い値を残すと、画面には正しい顔で出続ける（D-140 と同じ判断）。
-- 消したぶんはクライアントが次に保存するときに入れ直す。
--
-- 画面から見える変化は無いので news.json には足さない。
-- ============================================================

BEGIN;

ALTER TABLE public.fishing_records
  ADD COLUMN IF NOT EXISTS tide_phase_tenth SMALLINT,
  ADD COLUMN IF NOT EXISTS tide_phase_rising BOOLEAN;

ALTER TABLE public.fishing_records
  DROP CONSTRAINT IF EXISTS fishing_records_tide_phase_check;
ALTER TABLE public.fishing_records
  ADD CONSTRAINT fishing_records_tide_phase_check CHECK (
    -- **片方だけ入っている状態を作らない。** 「上げ」だけ・「7分」だけでは
    -- 数えようが無く、集計側が必ず片方を NULL 扱いし損ねる
    (tide_phase_tenth IS NULL AND tide_phase_rising IS NULL)
    OR (tide_phase_tenth BETWEEN 0 AND 10 AND tide_phase_rising IS NOT NULL)
  );

COMMENT ON COLUMN public.fishing_records.tide_phase_tenth IS
  '釣行時刻の潮位置。干潮を 0、満潮を 10 とした位置（上げ7分なら 7）。'
  '毎時潮位が要るので DB では出せず、記録した時点でクライアントが入れる。'
  'fished_at / fished_time を変えると消える（古い値は嘘になるため）。';
COMMENT ON COLUMN public.fishing_records.tide_phase_rising IS
  '潮位置の向き。true = 上げ / false = 下げ。tide_phase_tenth と必ず対で入る。';

-- ------------------------------------------------------------
-- 日付・時刻が変わったら潮位置を落とす（023 の関数を差し替え）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_fishing_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_skunked THEN
    NEW.catch_count     := 0;
    NEW.fish_species_id := NULL;
    NEW.fish_name_local := NULL;
    NEW.length_cm       := NULL;
    NEW.weight_g        := NULL;
  ELSIF COALESCE(NEW.catch_count, 0) < 1 THEN
    RAISE EXCEPTION 'ボウズでない場合、catch_count は 1 以上が必要です'
      USING ERRCODE = '23514';  -- check_violation
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.tide_snapshot IS NULL THEN
      NEW.tide_snapshot := public.auto_tide_snapshot(NEW.fished_at);
    END IF;
  ELSE
    IF NEW.fished_at IS DISTINCT FROM OLD.fished_at
      AND NEW.tide_snapshot IS NOT DISTINCT FROM OLD.tide_snapshot
      -- 手で入れたものだけ避ける（023）。決め方の名前では判定しない
      AND (NEW.tide_snapshot IS NULL
           OR NEW.tide_snapshot->>'source' IS DISTINCT FROM 'manual')
    THEN
      NEW.tide_snapshot := public.auto_tide_snapshot(NEW.fished_at);
    END IF;

    /* 潮位置は日付と時刻の両方から決まる。どちらかが動いたのに
       潮位置が据え置きなら、**それは前の日時の値**なので落とす。
       同じ UPDATE で新しい値が来ているなら、そちらを尊重する。 */
    IF (NEW.fished_at IS DISTINCT FROM OLD.fished_at
        OR NEW.fished_time IS DISTINCT FROM OLD.fished_time)
      AND NEW.tide_phase_tenth IS NOT DISTINCT FROM OLD.tide_phase_tenth
      AND NEW.tide_phase_rising IS NOT DISTINCT FROM OLD.tide_phase_rising
    THEN
      NEW.tide_phase_tenth  := NULL;
      NEW.tide_phase_rising := NULL;
    END IF;
  END IF;

  -- 集計キー（tide_correlation ビューが参照）をスナップショットと整合させる。
  -- 明示指定された tide_type は尊重する
  IF NEW.tide_snapshot ? 'tide_type'
     AND (NEW.tide_type IS NULL
          OR (TG_OP = 'UPDATE' AND NEW.tide_type IS NOT DISTINCT FROM OLD.tide_type
              AND NEW.tide_snapshot IS DISTINCT FROM OLD.tide_snapshot))
  THEN
    NEW.tide_type := NEW.tide_snapshot->>'tide_type';
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 一覧のビューに出す（032 に 2 列足しただけ。ほかは変えない）
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
       r.tide_phase_tenth,
       r.tide_phase_rising,
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

COMMIT;
