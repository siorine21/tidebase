-- ============================================================
-- 釣行日を変えたときに潮回りが付け直されない不具合を直す
--
-- 019 で潮回りの決め方を「月齢の四捨五入」から「旧暦日」に変え（D-062）、
-- auto_tide_snapshot が書く method を 'moon_age_approx' → 'lunar_day' にした。
-- ところが**判定する側（トリガー）を直し忘れていた**。
--
--   004 の normalize_fishing_record:
--     ... AND (NEW.tide_snapshot IS NULL
--              OR NEW.tide_snapshot->>'method' = 'moon_age_approx')
--
-- 019 以降に入った釣果の method は 'lunar_day' なので、この条件に当たらない。
-- つまり**釣行日を編集しても、潮回りが前の日付のまま残る**。
-- 手で入れた値を尊重するための条件が、自動で入れた値まで守ってしまっていた。
--
-- CI は 019 の時点から落ち続けていたが、
-- 「テストが古いだけ」と決めつけて放置していた。テストは正しく壊れていた。
--
-- 直し方は 2 つ。
--   1. これから: 自動で付けた印であれば決め方の名前によらず付け直す。
--      名前を並べて書くと、次に決め方を変えたときにまた同じ穴が開く。
--      「手で入れたものか（source = 'manual'）」だけを見て、それ以外は自動とみなす。
--   2. すでに入っているぶん: 019 のあとに日付を編集した釣果は、
--      古い日付の潮回りを持ったままなので、まとめて引き直す。
-- ============================================================

BEGIN;

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
  ELSIF NEW.fished_at IS DISTINCT FROM OLD.fished_at
    AND NEW.tide_snapshot IS NOT DISTINCT FROM OLD.tide_snapshot
    -- 手で入れたものだけ避ける。決め方の名前で判定すると、
    -- 決め方を変えるたびにここを直さねばならず、忘れると黙って古い値が残る
    AND (NEW.tide_snapshot IS NULL
         OR NEW.tide_snapshot->>'source' IS DISTINCT FROM 'manual')
  THEN
    -- fished_at 変更時、自動付与分のみ再計算（クライアント明示分には触らない）
    NEW.tide_snapshot := public.auto_tide_snapshot(NEW.fished_at);
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

-- 019 のあとに日付を編集した釣果は、古い日付の潮回りを持ったままになっている。
-- 手で入れたものには触らない。
UPDATE public.fishing_records r
SET tide_snapshot = public.auto_tide_snapshot(r.fished_at),
    tide_type     = public.tide_type(r.fished_at)
WHERE (r.tide_snapshot->>'source' IS DISTINCT FROM 'manual')
  AND (r.tide_snapshot->>'tide_type' IS DISTINCT FROM public.tide_type(r.fished_at)
       OR r.tide_type IS DISTINCT FROM public.tide_type(r.fished_at));

COMMIT;
