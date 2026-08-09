-- ============================================================
-- 到達段階（025）に合わせて、既存の正規化トリガを直す
--
-- normalize_fishing_record は「is_skunked なら匹数を 0 にし、魚の情報を消す」
-- という作りだった。二択のときはそれで良かったが、025 で段階が入ると崩れる:
--
--   ・バラシ / ミスバイトも is_skunked = true になる（釣果ではないので）
--   ・その結果、**「たぶんシーバス、60 くらいあった」が消える**
--   ・回数（catch_count）も 0 にされ、「2 回バラした」が残らない
--
-- 判定を is_skunked から outcome に移す。
--   none                    … 何も無し。匹数 0、魚の情報も消す（従来どおり）
--   landed/lost/bite/sighting … 1 以上を要求し、魚の情報は残す
--
-- 魚種やサイズは、バラシでは**推定**になる。それでも残す価値がある。
-- 「シーバスがいた」ことこそが記録したい中身なので（要望 2026-08-10）。
--
-- トリガの発火順は名前順。sync_record_outcome（025）→
-- trg_normalize_fishing_record の順に走るので、ここに来た時点で
-- outcome は必ず埋まっている。
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_fishing_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.outcome = 'none' THEN
    NEW.catch_count     := 0;
    NEW.fish_species_id := NULL;
    NEW.fish_name_local := NULL;
    NEW.length_cm       := NULL;
    NEW.weight_g        := NULL;
  ELSIF COALESCE(NEW.catch_count, 0) < 1 THEN
    -- 獲れた=匹数、バラシ・ミスバイト・目視=回数。どれも 1 以上
    RAISE EXCEPTION '何も無し以外は、匹数（回数）が 1 以上必要です'
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

COMMIT;
