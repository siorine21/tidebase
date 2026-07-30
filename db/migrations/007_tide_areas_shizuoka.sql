-- ============================================================
-- 潮汐地点の細分化（静岡県特化・浜名湖の時差補正）
--
-- 背景:
--   気象庁の潮位表地点は全国 239 点しかなく、静岡県内は 10 点
--   （舞阪・御前崎・焼津・清水港・田子・石廊崎・内浦・南伊豆・下田・伊東）。
--   浜名湖は今切口だけで遠州灘とつながる閉鎖性水域のため、湖内は
--   舞阪（湖口）に対して満干の時刻が大きく遅れる。舞阪の潮位表を
--   そのまま使うと湖奥では最大 3 時間ずれる。
--
-- 対応:
--   基準観測点（tide_stations）＋時差・潮高比を持つ「潮汐地点」
--   （tide_areas）を導入し、スポットに紐付ける。これは潮見表で
--   一般的な「標準港からの改正数」と同じ考え方。
--
-- 時差の出典（いずれも舞阪港基準。複数の浜名湖情報サイトで一致）:
--   村櫛 約2時間 / 細江湖・猪鼻瀬戸 約3時間
--   http://hamanako.chuchutea.com/smart/hamanako04.html
--   https://hanazono14.com/murakusikou-siojihyou.htm
--   https://tabinotomo.com/hamana/shiohigari.html
--
-- 潮高比（level_ratio）は公的な出典を確認できなかったため 1.00
-- （振幅補正なし）とし、時差のみを補正する。UI 側で「推算」と明示する。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. 観測点マスタに都道府県を持たせる（静岡特化の絞り込み用）
--    気象庁の一覧に県の列がないため、当面は静岡県とその隣接点のみ設定する
-- ------------------------------------------------------------
ALTER TABLE public.tide_stations
  ADD COLUMN IF NOT EXISTS pref TEXT;

-- 静岡県内の潮位表地点（+ 遠州灘西隣・伊豆東隣）。
-- 座標は気象庁「潮位表掲載地点一覧表」の度分表記を十進に変換したもの。
-- 全国 239 点は db/seeds/tide_stations.sql で投入するが、このマイグレーションが
-- 参照する地点はここで自給できるようにしておく（テスト DB でも成立させるため）。
INSERT INTO public.tide_stations (code, name, lat, lng, pref) VALUES
  ('MI', '舞阪',   34.6833, 137.6167, '静岡県'),   -- 浜名湖口
  ('OM', '御前崎', 34.6167, 138.2167, '静岡県'),
  ('Z5', '焼津',   34.8667, 138.3333, '静岡県'),
  ('SM', '清水港', 35.0167, 138.5167, '静岡県'),
  ('Z4', '田子',   34.8000, 138.7667, '静岡県'),
  ('G9', '石廊崎', 34.6167, 138.8500, '静岡県'),
  ('UC', '内浦',   35.0167, 138.8833, '静岡県'),
  ('QK', '南伊豆', 34.6333, 138.8833, '静岡県'),
  ('D6', '下田',   34.6833, 138.9667, '静岡県'),
  ('Z3', '伊東',   34.9000, 139.1333, '静岡県'),
  ('G4', '三河',   34.7333, 137.3167, '愛知県'),   -- 遠州灘の西隣
  ('OD', '小田原', 35.2333, 139.1500, '神奈川県') -- 伊豆の東隣
ON CONFLICT (code) DO UPDATE SET pref = EXCLUDED.pref;

-- ------------------------------------------------------------
-- 2. 潮汐地点（基準観測点 + 改正数）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tide_areas (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  pref              TEXT NOT NULL,
  water_body        TEXT,                    -- '浜名湖' など
  base_station_code TEXT NOT NULL REFERENCES public.tide_stations(code),
  -- 基準観測点に対する時差（分）。正なら基準より遅い
  lag_minutes       INTEGER NOT NULL DEFAULT 0,
  -- 潮高比。基準観測点の平均水面まわりの振幅にかける係数
  level_ratio       NUMERIC NOT NULL DEFAULT 1.00
                    CHECK (level_ratio > 0 AND level_ratio <= 2),
  lat               NUMERIC NOT NULL,
  lng               NUMERIC NOT NULL,
  note              TEXT,
  source            TEXT
);

COMMENT ON TABLE public.tide_areas IS
  '潮位表地点がない場所の潮汐地点。基準観測点の推算値に時差・潮高比を掛けて推定する。';
COMMENT ON COLUMN public.tide_areas.lag_minutes IS
  '基準観測点に対する満干時刻の遅れ（分）。出典は source 列を参照。';

ALTER TABLE public.tide_areas ENABLE ROW LEVEL SECURITY;

-- 公的データ由来のマスタなので全ユーザー読み取り可
-- 書き込みポリシーなし（管理は Management API = postgres ロールで行う。004 と同じ方針）
DROP POLICY IF EXISTS "tide_areas: read all" ON public.tide_areas;
CREATE POLICY "tide_areas: read all" ON public.tide_areas
  FOR SELECT USING (TRUE);

-- ------------------------------------------------------------
-- 3. 浜名湖の細分地点（基準はすべて舞阪 = MI）
--    座標は各エリアの代表点（概略）。UI から手動変更できる
-- ------------------------------------------------------------
INSERT INTO public.tide_areas
  (code, name, pref, water_body, base_station_code, lag_minutes, level_ratio, lat, lng, note, source)
VALUES
  ('HN-IMAGIRI',   '今切口・舞阪堤',   '静岡県', '浜名湖', 'MI',   0, 1.00, 34.6817, 137.5839,
   '外海と直結する湖口。舞阪の推算値をそのまま使える', '気象庁 潮位表（舞阪）'),
  ('HN-BENTEN',    '弁天島',           '静岡県', '浜名湖', 'MI',   0, 1.00, 34.6883, 137.6011,
   '湖口に近く、舞阪との差は 30 分未満とされる', '浜名湖潮干狩り情報サイト他'),
  ('HN-ARAI',      '新居・西岸',       '静岡県', '浜名湖', 'MI',   0, 1.00, 34.6864, 137.5719,
   '湖口西側。舞阪にほぼ準じる', '浜名湖潮干狩り情報サイト他'),
  ('HN-MURAKUSHI', '村櫛・表浜名湖',   '静岡県', '浜名湖', 'MI', 120, 1.00, 34.7186, 137.5936,
   '舞阪より約 2 時間遅れ', '浜名湖潮干狩り情報サイト / はなぞの釣具店 村櫛港潮時表'),
  ('HN-SHONAI',    '庄内湖',           '静岡県', '浜名湖', 'MI', 120, 1.00, 34.7361, 137.6178,
   '表浜名湖東奥。村櫛と同程度の遅れ', '浜名湖潮干狩り情報サイト（村櫛の値を準用）'),
  ('HN-SETO',      '猪鼻瀬戸',         '静岡県', '浜名湖', 'MI', 180, 1.00, 34.7719, 137.5811,
   '舞阪より約 3 時間遅れ', '浜名湖潮干狩り情報サイト'),
  ('HN-INOHANA',   '猪鼻湖',           '静岡県', '浜名湖', 'MI', 180, 1.00, 34.7856, 137.5761,
   '瀬戸の奥。瀬戸と同程度の遅れ', '浜名湖潮干狩り情報サイト（瀬戸の値を準用）'),
  ('HN-HOSOE',     '細江湖（引佐細江）', '静岡県', '浜名湖', 'MI', 180, 1.00, 34.7856, 137.6108,
   '舞阪より約 3 時間遅れ', '浜名湖潮干狩り情報サイト'),
  ('HN-KIGA',      '気賀・都田川河口', '静岡県', '浜名湖', 'MI', 180, 1.00, 34.7936, 137.6222,
   '奥浜名湖最奥。細江湖と同程度の遅れ', '浜名湖潮干狩り情報サイト（細江湖の値を準用）')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, pref = EXCLUDED.pref, water_body = EXCLUDED.water_body,
  base_station_code = EXCLUDED.base_station_code,
  lag_minutes = EXCLUDED.lag_minutes, level_ratio = EXCLUDED.level_ratio,
  lat = EXCLUDED.lat, lng = EXCLUDED.lng,
  note = EXCLUDED.note, source = EXCLUDED.source;

-- ------------------------------------------------------------
-- 4. スポットへの紐付け
-- ------------------------------------------------------------
ALTER TABLE public.spots
  ADD COLUMN IF NOT EXISTS tide_area_code TEXT REFERENCES public.tide_areas(code);

COMMENT ON COLUMN public.spots.tide_area_code IS
  '細分化した潮汐地点。設定時は tide_station_code より優先して使う。';

-- 最近傍の潮汐地点。半径外なら NULL（= 通常の観測点を使う）
CREATE OR REPLACE FUNCTION public.nearest_tide_area(
  p_lat NUMERIC, p_lng NUMERIC, p_max_km NUMERIC DEFAULT 4
)
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT code
  FROM public.tide_areas
  WHERE public.haversine_km(p_lat, p_lng, lat, lng) <= p_max_km
  ORDER BY public.haversine_km(p_lat, p_lng, lat, lng)
  LIMIT 1;
$$;

-- ------------------------------------------------------------
-- 5. 観測点・潮汐地点の自動割り当て（004 のトリガーを拡張）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_tide_station()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  coords_changed BOOLEAN;
BEGIN
  IF NEW.water_type = 'freshwater' THEN
    -- 淡水は潮汐対象外
    NEW.tide_station_code := NULL;
    NEW.tide_area_code := NULL;
    RETURN NEW;
  END IF;

  coords_changed := TG_OP = 'UPDATE'
    AND (NEW.latitude IS DISTINCT FROM OLD.latitude
      OR NEW.longitude IS DISTINCT FROM OLD.longitude
      OR NEW.water_type IS DISTINCT FROM OLD.water_type);

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

DROP TRIGGER IF EXISTS trg_assign_tide_station ON public.spots;
CREATE TRIGGER trg_assign_tide_station
  BEFORE INSERT OR UPDATE ON public.spots
  FOR EACH ROW EXECUTE FUNCTION public.assign_tide_station();

-- 既存スポットへの一括適用（再実行しても安全）
UPDATE public.spots
SET tide_area_code = public.nearest_tide_area(latitude, longitude)
WHERE water_type <> 'freshwater' AND tide_area_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_spots_tide_area ON public.spots(tide_area_code);

COMMIT;
