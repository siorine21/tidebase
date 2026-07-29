-- ============================================================
-- TIDEBASE DB スキーマ v1.3 → v1.4 差分
-- 【アーキテクチャ移行】AWS 撤去に伴い、FastAPI 層が担っていた
-- ドメインロジックを DB（トリガー・関数・RPC）へ移植する（D-021）
-- 適用方法: scripts/supabase_admin.py apply（003 適用後）
-- 根拠: docs/design/TIDEBASE_アーキテクチャ移行_v1.0.md
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. 潮汐観測点マスタ（旧 backend/app/data/jma_tide_stations.json）
--    seed は東京のみ。全地点は scripts/generate_tide_stations.py で
--    SQL を生成して投入する
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tide_stations (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{2}$'),
  name TEXT NOT NULL,
  lat  NUMERIC(8,4) NOT NULL,
  lng  NUMERIC(9,4) NOT NULL
);

ALTER TABLE public.tide_stations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tide_stations: read all" ON public.tide_stations;
CREATE POLICY "tide_stations: read all" ON public.tide_stations
  FOR SELECT USING (true);
-- 書き込みポリシーなし（管理は Management API = postgres ロールで行う）

INSERT INTO public.tide_stations (code, name, lat, lng) VALUES
  ('TK', '東京', 35.6544, 139.7708)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------
-- 2. 月齢・潮回り（旧 app/services/tide.py の moon_age / tide_type）
--    月齢は朔（2000-01-06 18:14 UTC）からの経過日数の近似（D-002）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.moon_age(target DATE)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE
AS $$
  -- JST 正午（= UTC 03:00）時点の月齢
  SELECT ROUND(
    (
      (
        EXTRACT(EPOCH FROM ((target::timestamp + INTERVAL '3 hours') AT TIME ZONE 'UTC'))
        - EXTRACT(EPOCH FROM TIMESTAMPTZ '2000-01-06 18:14:00+00')
      ) / 86400.0
    )::numeric % 29.530588853,
    1
  );
$$;

CREATE OR REPLACE FUNCTION public.tide_type(target DATE)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN idx IN (0, 1, 2, 14, 15, 16, 17, 29) THEN '大潮'
    WHEN idx IN (3, 4, 5, 6, 12, 13, 18, 19, 20, 21, 27, 28) THEN '中潮'
    WHEN idx IN (7, 8, 9, 22, 23, 24) THEN '小潮'
    WHEN idx IN (10, 25) THEN '長潮'
    ELSE '若潮'  -- 11, 26
  END
  FROM (SELECT ROUND(public.moon_age(target))::int % 30 AS idx) t;
$$;

CREATE OR REPLACE FUNCTION public.auto_tide_snapshot(p_fished_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql IMMUTABLE
AS $$
  -- 日付境界は JST（D-011）
  SELECT jsonb_build_object(
    'tide_type', public.tide_type(d),
    'moon_age',  public.moon_age(d),
    'method',    'moon_age_approx'
  )
  FROM (SELECT (p_fished_at AT TIME ZONE 'Asia/Tokyo')::date AS d) t;
$$;

-- ------------------------------------------------------------
-- 3. 釣果の整合性 + 潮汐スナップショット自動付与トリガー
--    （旧 RecordCreate バリデーション + D-012。どの経路からも破れない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_fishing_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_skunked THEN
    -- ボウズは catch_count = 0・魚情報なし（確定仕様書 6.2 章）
    NEW.catch_count       := 0;
    NEW.fish_species_id   := NULL;
    NEW.fish_display_name := NULL;
    NEW.size_cm           := NULL;
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
    AND (NEW.tide_snapshot IS NULL
         OR NEW.tide_snapshot->>'method' = 'moon_age_approx')
  THEN
    -- fished_at 変更時、自動付与分のみ再計算（クライアント明示分には触らない）
    NEW.tide_snapshot := public.auto_tide_snapshot(NEW.fished_at);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_fishing_record ON public.fishing_records;
CREATE TRIGGER trg_normalize_fishing_record
  BEFORE INSERT OR UPDATE ON public.fishing_records
  FOR EACH ROW EXECUTE FUNCTION public.normalize_fishing_record();

-- ------------------------------------------------------------
-- 4. 最寄り観測点の自動設定（旧 app/services/tide_stations.py）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.haversine_km(
  lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE
AS $$
  SELECT 2 * 6371 * asin(sqrt(
    pow(sin(radians((lat2 - lat1) / 2)), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
      * pow(sin(radians((lng2 - lng1) / 2)), 2)
  ))::numeric;
$$;

CREATE OR REPLACE FUNCTION public.nearest_tide_station(
  p_lat NUMERIC, p_lng NUMERIC, p_max_km NUMERIC DEFAULT 150
)
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT code
  FROM public.tide_stations
  WHERE public.haversine_km(p_lat, p_lng, lat, lng) <= p_max_km
  ORDER BY public.haversine_km(p_lat, p_lng, lat, lng)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.assign_tide_station()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.water_type = 'freshwater' THEN
    NEW.tide_station_code := NULL;  -- 淡水は潮汐対象外
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.tide_station_code IS NULL THEN
      NEW.tide_station_code := public.nearest_tide_station(NEW.latitude, NEW.longitude);
    END IF;
  ELSIF (NEW.latitude IS DISTINCT FROM OLD.latitude
         OR NEW.longitude IS DISTINCT FROM OLD.longitude
         OR NEW.water_type IS DISTINCT FROM OLD.water_type)
    AND NEW.tide_station_code IS NOT DISTINCT FROM OLD.tide_station_code
  THEN
    -- 座標・水域区分の変更時は再計算（観測点の明示変更があればそちらを優先）
    NEW.tide_station_code := public.nearest_tide_station(NEW.latitude, NEW.longitude);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_tide_station ON public.spots;
CREATE TRIGGER trg_assign_tide_station
  BEFORE INSERT OR UPDATE ON public.spots
  FOR EACH ROW EXECUTE FUNCTION public.assign_tide_station();

-- 既存スポットへの一括適用（マスタ拡充後に再実行しても安全）
UPDATE public.spots
SET tide_station_code = public.nearest_tide_station(latitude, longitude)
WHERE water_type <> 'freshwater' AND tide_station_code IS NULL;

-- ------------------------------------------------------------
-- 5. スポット削除ガード（確定仕様書 17.2 章・旧 delete_spot の 409）
--    ERRCODE 23503 により PostgREST は 409 Conflict を返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_spot_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  linked_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO linked_count
  FROM public.fishing_records
  WHERE spot_id = OLD.id;

  IF linked_count > 0 THEN
    RAISE EXCEPTION '釣果記録が%件紐付いているため削除できません。先にスポットを一括変更してください。',
      linked_count
      USING ERRCODE = '23503';  -- foreign_key_violation → PostgREST 409
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_spot_delete ON public.spots;
CREATE TRIGGER trg_guard_spot_delete
  BEFORE DELETE ON public.spots
  FOR EACH ROW EXECUTE FUNCTION public.guard_spot_delete();

-- ------------------------------------------------------------
-- 6. 出世魚判定 RPC（旧 GET /api/v1/fish-name/suggest）
--    PostgREST: POST /rest/v1/rpc/suggest_fish_name
--    SECURITY INVOKER のため fish_species の RLS がそのまま効く
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.suggest_fish_name(
  p_fish_species_id UUID, p_size_cm NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_group TEXT;
  v_name  TEXT;
BEGIN
  SELECT name_rule_group INTO v_group
  FROM public.fish_species
  WHERE id = p_fish_species_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '魚種が見つかりません' USING ERRCODE = 'P0002';
  END IF;

  IF v_group IS NULL THEN
    RETURN jsonb_build_object(
      'suggested_name', NULL, 'rule_group', NULL, 'matched', false);
  END IF;

  SELECT display_name INTO v_name
  FROM public.fish_name_rules
  WHERE rule_group = v_group
    AND region = 'kanto'
    AND (min_cm IS NULL OR p_size_cm >= min_cm)
    AND (max_cm IS NULL OR p_size_cm < max_cm)
  ORDER BY sort_order
  LIMIT 1;

  RETURN jsonb_build_object(
    'suggested_name', v_name,
    'rule_group', v_group,
    'matched', v_name IS NOT NULL
  );
END;
$$;

COMMIT;
