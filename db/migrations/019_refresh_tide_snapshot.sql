-- ============================================================
-- 保存済み釣果の tide_snapshot を引き直す
--
-- 018 は「潮回りが変わる行」だけ更新した。だが tide_snapshot には
-- **月齢**も入っていて、こちらは潮回りが変わらない行でも古い近似値のまま残る。
-- 釣果詳細は `tide_snapshot.moon_age` をそのまま表示しているので、
-- 画面に古い月齢が出てしまう。
--
-- 潮回りも月齢も釣行日から決まる派生値で、入力値ではない。
-- 間違ったまま残す理由がないので、全行を引き直す。
-- ============================================================

BEGIN;

UPDATE public.fishing_records r
SET tide_type = public.tide_type(r.fished_at),
    tide_snapshot = COALESCE(r.tide_snapshot, '{}'::jsonb) || jsonb_build_object(
      'tide_type', public.tide_type(r.fished_at),
      'moon_age',  public.moon_age(r.fished_at),
      'method',    'lunar_day')
WHERE public.tide_type(r.fished_at) IS NOT NULL
  AND (r.tide_snapshot->>'method' IS DISTINCT FROM 'lunar_day'
       OR r.tide_type IS DISTINCT FROM public.tide_type(r.fished_at));

-- これから保存される釣果も新しい基準で入るようにする（004 の関数を差し替え）
CREATE OR REPLACE FUNCTION public.auto_tide_snapshot(p_fished_at DATE)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'tide_type', public.tide_type(p_fished_at),
    'moon_age',  public.moon_age(p_fished_at),
    'method',    'lunar_day'
  );
$$;

COMMIT;
