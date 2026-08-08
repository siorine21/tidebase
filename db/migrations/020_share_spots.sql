-- ============================================================
-- スポットをグループ内で共有する
--
-- 要望（2026-08-09）: 他人が登録したスポットも完全に共有して表示したい。
--   一覧には誰が登録したかを出さず、詳細に出ていればよい。
--
-- 釣果（record_feed・010）と同じ作り方にする。
--   - `spots` の RLS は**広げない**。書き込みは今までどおり自分の行だけ。
--   - 読むための入口として、列を絞ったビューを別に用意する。
--     「他人のスポットは編集できない」がビューの有無ではなく
--     テーブルの RLS で担保されるので、画面の作りに左右されない。
--
-- 釣果と違って visibility の区別は持たせない。スポットは「どこで釣れるか」の
-- 共有そのものが目的で、隠したいものは登録しない、という整理にする
-- （隠したい場所は、そもそもグループに見せない釣果として記録すればよい）。
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.spot_feed;
CREATE VIEW public.spot_feed
WITH (security_invoker = false) AS
SELECT
  s.id,
  s.user_id,
  s.user_id = auth.uid() AS is_mine,
  public.display_name(p.username) AS owner_name,
  s.name,
  s.spot_type,
  s.water_type,
  s.latitude,
  s.longitude,
  s.tide_station_code,
  s.tide_area_code,
  s.low_tide_only,
  s.visibility,
  s.memo,
  s.created_at
FROM public.spots s
JOIN public.profiles p ON p.id = s.user_id
WHERE s.user_id = auth.uid()
   OR public.shares_group_with(s.user_id);

GRANT SELECT ON public.spot_feed TO authenticated;

COMMENT ON VIEW public.spot_feed IS
  'スポットの共有ビュー（D-065）。自分のもの＋同じグループの人のもの。'
  '書き込みは spots の RLS（自分の行のみ）が担保する。';

COMMIT;
