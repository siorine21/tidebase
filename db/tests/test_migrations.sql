-- ============================================================
-- マイグレーション適用後の動作テスト
-- （baseline_v1.1_actual.sql → 002 → 003 → 004 の順に適用後に実行）
-- 失敗時は RAISE EXCEPTION で異常終了する（run_local.sh / CI 用）
-- ============================================================

\set ON_ERROR_STOP on

-- テストユーザー（handle_new_user トリガーが profiles とメソッドを作る）
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111');

DO $$
BEGIN
  -- 会員登録トリガーの検証（確定仕様書 18.3 章: デフォルト 10 件のコピー）
  IF (SELECT COUNT(*) FROM public.profiles
      WHERE id = '11111111-1111-1111-1111-111111111111') <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: handle_new_user が profiles を作らない';
  END IF;
  IF (SELECT COUNT(*) FROM public.methods
      WHERE user_id = '11111111-1111-1111-1111-111111111111') <> 10 THEN
    RAISE EXCEPTION 'TEST FAIL: 初期メソッド 10 件がコピーされない（実際: %）',
      (SELECT COUNT(*) FROM public.methods);
  END IF;
END;
$$;

DO $$
DECLARE
  u CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  spot_tokyo UUID;
  spot_sapporo UUID;
  spot_fresh UUID;
  spot_target UUID;
  rec RECORD;
  buri_id UUID;
  trout_id UUID;
  result JSONB;
  age1 NUMERIC;
  age2 NUMERIC;
  failed BOOLEAN := FALSE;
BEGIN
  ------------------------------------------------------------
  -- 観測点自動設定（設計補完書 3 章）
  ------------------------------------------------------------
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '東京湾テスト', 35.1234, 139.5678) RETURNING id INTO spot_tokyo;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_tokyo) IS DISTINCT FROM 'TK' THEN
    RAISE EXCEPTION 'TEST FAIL: 東京湾スポットに TK が自動設定されない';
  END IF;

  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '札幌テスト', 43.06, 141.35) RETURNING id INTO spot_sapporo;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_sapporo) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 150km 圏外で NULL にならない';
  END IF;

  INSERT INTO public.spots (user_id, name, latitude, longitude, water_type)
  VALUES (u, 'エリアテスト', 35.1234, 139.5678, 'freshwater') RETURNING id INTO spot_fresh;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_fresh) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 淡水スポットで NULL にならない';
  END IF;

  -- 座標変更で再計算（札幌 → 東京湾）
  UPDATE public.spots SET latitude = 35.2, longitude = 139.7 WHERE id = spot_sapporo;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_sapporo) IS DISTINCT FROM 'TK' THEN
    RAISE EXCEPTION 'TEST FAIL: 座標変更で観測点が再計算されない';
  END IF;

  -- 明示変更はそのまま維持
  UPDATE public.spots SET tide_station_code = 'ZZ', latitude = 35.3 WHERE id = spot_sapporo;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_sapporo) IS DISTINCT FROM 'ZZ' THEN
    RAISE EXCEPTION 'TEST FAIL: 観測点の明示指定が上書きされる';
  END IF;

  ------------------------------------------------------------
  -- 釣果: 潮汐スナップショット自動付与（D-012）
  ------------------------------------------------------------
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, catch_count)
  VALUES (u, spot_tokyo, '2026-07-10', 2) RETURNING * INTO rec;
  IF rec.tide_snapshot->>'method' IS DISTINCT FROM 'moon_age_approx'
     OR NOT (rec.tide_snapshot->>'tide_type' IN ('大潮','中潮','小潮','長潮','若潮')) THEN
    RAISE EXCEPTION 'TEST FAIL: tide_snapshot 自動付与が不正: %', rec.tide_snapshot;
  END IF;
  -- 集計キー（ビューが参照）がスナップショットと一致すること
  IF rec.tide_type IS DISTINCT FROM rec.tide_snapshot->>'tide_type' THEN
    RAISE EXCEPTION 'TEST FAIL: tide_type カラムがスナップショットと不一致';
  END IF;
  age1 := (rec.tide_snapshot->>'moon_age')::numeric;

  -- fished_at 変更 → 自動付与分は再計算
  UPDATE public.fishing_records SET fished_at = '2026-07-17'
  WHERE id = rec.id RETURNING * INTO rec;
  age2 := (rec.tide_snapshot->>'moon_age')::numeric;
  IF age1 = age2 THEN
    RAISE EXCEPTION 'TEST FAIL: fished_at 変更で moon_age が再計算されない';
  END IF;
  IF rec.tide_type IS DISTINCT FROM rec.tide_snapshot->>'tide_type' THEN
    RAISE EXCEPTION 'TEST FAIL: fished_at 変更後に tide_type が追従しない';
  END IF;

  -- 手動スナップショットは維持
  UPDATE public.fishing_records
  SET tide_snapshot = '{"tide_type": "大潮", "source": "manual"}'::jsonb
  WHERE id = rec.id;
  UPDATE public.fishing_records SET fished_at = '2026-07-20'
  WHERE id = rec.id RETURNING * INTO rec;
  IF rec.tide_snapshot->>'source' IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'TEST FAIL: 手動スナップショットが上書きされる';
  END IF;

  -- 潮汐×釣果相関ビュー（確定仕様書 14.3 章）が集計できること
  IF NOT EXISTS (SELECT 1 FROM public.tide_correlation WHERE user_id = u) THEN
    RAISE EXCEPTION 'TEST FAIL: tide_correlation ビューが集計しない';
  END IF;

  ------------------------------------------------------------
  -- 釣果: ボウズ整合性（確定仕様書 6.2 章）
  ------------------------------------------------------------
  SELECT id INTO buri_id FROM public.fish_species WHERE user_id IS NULL AND name = 'ブリ';
  INSERT INTO public.fishing_records
    (user_id, spot_id, fished_at, is_skunked, catch_count, fish_species_id,
     fish_name_local, length_cm, weight_g)
  VALUES (u, spot_tokyo, '2026-07-11', TRUE, 5, buri_id, 'イナダ', 42.5, 1200)
  RETURNING * INTO rec;
  IF rec.catch_count <> 0 OR rec.fish_species_id IS NOT NULL
     OR rec.fish_name_local IS NOT NULL OR rec.length_cm IS NOT NULL
     OR rec.weight_g IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: ボウズの正規化が効かない';
  END IF;

  -- 公開範囲のデフォルト（確定仕様書 5 章）
  IF rec.visibility IS DISTINCT FROM 'group' THEN
    RAISE EXCEPTION 'TEST FAIL: visibility のデフォルトが group でない';
  END IF;

  BEGIN
    INSERT INTO public.fishing_records (user_id, spot_id, fished_at, catch_count)
    VALUES (u, spot_tokyo, '2026-07-12', 0);
    failed := TRUE;
  EXCEPTION WHEN check_violation THEN
    NULL;  -- 期待どおり
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: catch_count=0（非ボウズ）が通ってしまう';
  END IF;

  ------------------------------------------------------------
  -- 出世魚判定 RPC（確定仕様書 1.2 章）
  ------------------------------------------------------------
  IF public.suggest_fish_name(buri_id, 42.5)->>'suggested_name' IS DISTINCT FROM 'イナダ'
     OR public.suggest_fish_name(buri_id, 34.9)->>'suggested_name' IS DISTINCT FROM 'ワカシ'
     OR public.suggest_fish_name(buri_id, 35.0)->>'suggested_name' IS DISTINCT FROM 'イナダ'
     OR public.suggest_fish_name(buri_id, 60.0)->>'suggested_name' IS DISTINCT FROM 'ワラサ'
     OR public.suggest_fish_name(buri_id, 80.0)->>'suggested_name' IS DISTINCT FROM 'ブリ' THEN
    RAISE EXCEPTION 'TEST FAIL: ブリ系の呼称判定が仕様と不一致';
  END IF;

  SELECT id INTO trout_id FROM public.fish_species WHERE user_id IS NULL AND name = 'トラウト';
  result := public.suggest_fish_name(trout_id, 40);
  IF (result->>'matched')::boolean IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'TEST FAIL: 対象外魚種で matched=false にならない';
  END IF;

  BEGIN
    PERFORM public.suggest_fish_name(gen_random_uuid(), 40);
    failed := TRUE;
  EXCEPTION WHEN no_data_found THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 存在しない魚種でエラーにならない';
  END IF;

  ------------------------------------------------------------
  -- スポット削除ガード + 一括変更（確定仕様書 17 章）
  ------------------------------------------------------------
  BEGIN
    DELETE FROM public.spots WHERE id = spot_tokyo;
    failed := TRUE;
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;  -- PostgREST では 409 になる
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 釣果紐付きスポットが削除できてしまう';
  END IF;

  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '移行先', 35.2, 139.6) RETURNING id INTO spot_target;
  UPDATE public.fishing_records SET spot_id = spot_target WHERE spot_id = spot_tokyo;
  DELETE FROM public.spots WHERE id = spot_tokyo;  -- 今度は成功するはず

  ------------------------------------------------------------
  -- 魚種 seed の冪等性（002 の再実行相当）
  ------------------------------------------------------------
  INSERT INTO public.fish_species (user_id, name, category)
  VALUES (NULL, 'ブリ', '海水')
  ON CONFLICT (user_id, name) DO NOTHING;
  IF (SELECT COUNT(*) FROM public.fish_species WHERE user_id IS NULL AND name = 'ブリ') <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: システムデフォルト魚種が重複する';
  END IF;

  RAISE NOTICE 'ALL DB TESTS PASSED';
END;
$$;
