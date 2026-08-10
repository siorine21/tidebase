-- ============================================================
-- スポットに「立ち位置」（おかっぱり / ウェーディング）を足す
--
-- 要望（2026-08-10）: カテゴリにウェーディングを追加したい。
--   おかっぱりからやるのか、ウェーディングするのかでかなり差がある。
--
-- **カテゴリ（spot_type）の値にはしない。** 実際の登録がそれを示している:
--
--   二瀬橋            river / brackish
--   二瀬橋(ウェーディング)  river / brackish   ← 同じ場所・同じ種別
--   太田川ワンド           saltwater
--   太田川ワンド(ウェーディング) brackish       ← 同じ場所
--
-- 同じ場所を 2 件に分けて、名前で区別している。つまりウェーディングは
-- **場所の種類ではなく、そこでの立ち位置**。種別の値にしてしまうと、
-- 「二瀬橋(ウェーディング)」が河川でなくなり、水域の情報が消える。
--
-- 別の軸にしておくと、種別と掛け合わせられる:
--   ・サーフ／河口／干潟／河川、どれもウェーディングしうる
--   ・「今日はウェーディングできるか」で絞れる
--   ・**潮位との関係が種別だけでは決まらない。** 立ち込みは満潮では入れない
--     ことがあり、既にある low_tide_only と合わせて釣行スコアに効かせられる
--
-- 値は 2 つだけにする。「どちらでもできる」を入れたくなるが、
-- 本人は既に**場所を分けて登録している**ので、1 件につき 1 つで足りる。
-- NULL は「未設定」。既存の大半がそれなので、決めつけて埋めない。
-- ============================================================

BEGIN;

ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS entry_style TEXT;

COMMENT ON COLUMN public.spots.entry_style IS
  '立ち位置: bank おかっぱり / wading ウェーディング。NULL は未設定。'
  'spot_type（場所の種類）とは別の軸。同じ河口でも両方ありうる。';

ALTER TABLE public.spots
  DROP CONSTRAINT IF EXISTS spots_entry_style_check;
ALTER TABLE public.spots
  ADD CONSTRAINT spots_entry_style_check
  CHECK (entry_style IS NULL OR entry_style IN ('bank', 'wading'));

-- 名前に書いてあるぶんだけ拾う。書いていないものは「おかっぱり」と
-- 決めつけずに未設定のままにする（管理釣り場や漁港も混ざっているため）
UPDATE public.spots
   SET entry_style = 'wading'
 WHERE entry_style IS NULL
   AND name ILIKE '%ウェーディング%';

-- 名前の「(ウェーディング)」は消さない。いまはそれがスポット選択での
-- 見分けになっている。消すと同名が 2 つ並ぶ。付け替えは本人の判断に任せる。

-- ------------------------------------------------------------
-- 一覧のビューに entry_style を足す
-- 列を途中に挟むので CREATE OR REPLACE は使えない（列の追加は末尾のみ）。
-- security_invoker = false のままにすること。WHERE 句が境界そのもの（020）。
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.spot_feed;
CREATE VIEW public.spot_feed
WITH (security_invoker = false) AS
SELECT s.id,
       s.user_id,
       s.user_id = auth.uid() AS is_mine,
       display_name(p.username) AS owner_name,
       s.name,
       s.spot_type,
       s.entry_style,
       s.water_type,
       s.latitude,
       s.longitude,
       s.tide_station_code,
       s.tide_area_code,
       s.low_tide_only,
       s.visibility,
       s.memo,
       s.created_at
  FROM spots s
  JOIN profiles p ON p.id = s.user_id
 WHERE s.user_id = auth.uid() OR shares_group_with(s.user_id);

GRANT SELECT ON public.spot_feed TO authenticated;

COMMENT ON VIEW public.spot_feed IS
  'スポット一覧。自分の分と、グループで共有された分だけを返す。'
  'security_invoker = false なので、この WHERE 句が境界そのもの。';

COMMIT;
