BEGIN;

-- 037: 感潮（潮汐が届くか）を、塩分とは別の軸として持つ（D-134）
--
-- **感潮域と汽水域は同じものではない。**
-- 国土交通省「河川砂防技術基準 調査編」第14章（汽水域・河口域の環境調査）:
--   感潮区間  … 河口から、潮汐の変動によって水位が変動する区間
--   塩水遡上区間 … 河口から塩水が遡上する区間
--   汽水域    … 河川水と海水が接触・混合する部分。塩分 0.5〜30‰
-- 同基準は「感潮域にも淡水の区間が存在し、水位に対する潮汐の影響は
-- 塩分濃度が 0.5‰ より低い区間にまで及ぶため、感潮域と汽水域は
-- 必ずしも一致しない」と明記している。
-- 包含関係は 感潮域 ⊃ 塩水遡上区間 ⊃ 汽水域。
--
-- したがって **塩分（water_type）から感潮は導けない**。
-- water_type に「感潮」を足すと「感潮にすると淡水でなくなる」ことになるので、
-- 掛け合わせられる別の列として持つ（D-099 の立ち位置と同じ形）。
--
-- これまでは assign_tide_station() が water_type = 'freshwater' のとき
-- 潮汐地点を**強制的に NULL**にしていた。手で設定しても保存時に消えるので、
-- 5km 上流の「淡水だが感潮」のスポットが潮汐を持てなかった。

ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS tide_influence TEXT;

ALTER TABLE public.spots
  DROP CONSTRAINT IF EXISTS spots_tide_influence_check;
ALTER TABLE public.spots
  ADD CONSTRAINT spots_tide_influence_check
  CHECK (tide_influence IS NULL OR tide_influence IN ('tidal', 'none'));

COMMENT ON COLUMN public.spots.tide_influence IS
  '潮汐が届くか（D-134）。**塩分（water_type）とは別の軸。**'
  'NULL=自動（水域から推定）/ tidal=あり / none=なし。'
  '淡水 + tidal が「感潮域」（塩分は淡水だが潮位は動く）。'
  '自動を距離だけで決めないのは、nearest_tide_station の既定半径が 150km あり、'
  '内陸の管理釣り場まで拾ってしまうため。';

-- ------------------------------------------------------------
-- 潮汐地点の自動割り当て（007 を置き換え）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_tide_station()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  coords_changed BOOLEAN;
  tidal BOOLEAN;
BEGIN
  /* 潮汐が届くかは tide_influence が決める（D-134）。
     書いていなければ（NULL＝自動）水域から推定する。
     **水域を見るのは既定値を決めるときだけ**で、手で指定してあれば
     淡水でも潮汐が効く（感潮域）。 */
  tidal := CASE
    WHEN NEW.tide_influence = 'tidal' THEN TRUE
    WHEN NEW.tide_influence = 'none'  THEN FALSE
    ELSE NEW.water_type IS DISTINCT FROM 'freshwater'
  END;

  IF NOT tidal THEN
    NEW.tide_station_code := NULL;
    NEW.tide_area_code := NULL;
    RETURN NEW;
  END IF;

  coords_changed := TG_OP = 'UPDATE'
    AND (NEW.latitude IS DISTINCT FROM OLD.latitude
      OR NEW.longitude IS DISTINCT FROM OLD.longitude
      OR NEW.water_type IS DISTINCT FROM OLD.water_type
      -- 「なし」から戻したときに、割り当て直しが走るようにする
      OR NEW.tide_influence IS DISTINCT FROM OLD.tide_influence);

  -- 座標が変わったとき、指定が据え置きなら再計算対象として一旦クリアする
  -- （同じ UPDATE で明示的に指定を変えた場合はそちらを尊重する）
  IF coords_changed THEN
    IF NEW.tide_station_code IS NOT DISTINCT FROM OLD.tide_station_code THEN
      NEW.tide_station_code := NULL;
    END IF;
    IF NEW.tide_area_code IS NOT DISTINCT FROM OLD.tide_area_code THEN
      NEW.tide_area_code := NULL;
    END IF;
  END IF;

  -- NULL は「自動で決める」の意味。UI の「座標から自動で決める」がこれを使う
  IF NEW.tide_station_code IS NULL THEN
    NEW.tide_station_code := public.nearest_tide_station(NEW.latitude, NEW.longitude);
  END IF;
  IF NEW.tide_area_code IS NULL THEN
    NEW.tide_area_code := public.nearest_tide_area(NEW.latitude, NEW.longitude);
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 一覧のビューに tide_influence を足す
-- **末尾に足すので CREATE OR REPLACE が使える。**
-- DROP + CREATE すると ACL が初期化されて anon まで権限が戻る（D-124）。
-- 途中に挟みたい誘惑に負けないこと。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.spot_feed
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
       s.created_at,
       s.tide_influence
  FROM spots s
  JOIN profiles p ON p.id = s.user_id
 WHERE s.user_id = auth.uid() OR shares_group_with(s.user_id);

COMMIT;
