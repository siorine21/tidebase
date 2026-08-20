-- ============================================================
-- 034: 「いつ直したか」を残す（D-125）
--
-- 監査列を数えたら created_at は 21 表中 12、**updated_at は 0** だった。
-- つまり「この記録、いつ書き換わった？」に一切答えられない。
-- 論理削除も無く、無料プランなのでバックアップも無い（実際に問い合わせて
-- backups: [] / pitr_enabled: false を確認した）。**消えたら終わり**の構成なので、
-- せめて「変わった時刻」だけは持っておく。
--
-- 入れるのは**画面から実際に更新している表だけ**。
-- fishing_records / spots / lure_recipes / profiles / tackle_items の 5 つ。
-- マスタ（tide_stations など）や、作って消すだけの表には要らない。
--
-- **既存の行は created_at で埋める。** now() のままにすると、
-- 「全部の記録が今日いっせいに編集された」という嘘の足あとが残る。
-- ============================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.touch_updated_at() IS
  'BEFORE UPDATE で updated_at を現在時刻にする（034）。'
  ' SECURITY DEFINER にはしない（呼び出し元の権限のままでよい）。';

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fishing_records', 'spots', 'lure_recipes', 'profiles', 'tackle_items'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', t);

    -- 既存の行は「作られた時刻＝最後に変わった時刻」とみなす。
    -- created_at を持たない表（tackle_items 等）はそのまま now() で構わない。
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'created_at'
    ) THEN
      EXECUTE format(
        'UPDATE public.%I SET updated_at = created_at WHERE created_at IS NOT NULL AND updated_at <> created_at', t);
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'touch_' || t, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', 'touch_' || t, t);
  END LOOP;
END;
$$;
