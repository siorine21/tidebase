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
  -- 観測点マスタの件数に依存しないよう「最近傍と一致するか」で検証する
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_tokyo)
     IS DISTINCT FROM public.nearest_tide_station(35.1234, 139.5678) THEN
    RAISE EXCEPTION 'TEST FAIL: 海水スポットに最近傍の観測点が自動設定されない';
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
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_sapporo)
     IS DISTINCT FROM public.nearest_tide_station(35.2, 139.7) THEN
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
  -- 退会（アカウント削除）で個人データが消せること（005）
  -- 釣果が紐付いたスポットがあってもガードに阻まれない
  ------------------------------------------------------------
  INSERT INTO auth.users (id) VALUES ('22222222-2222-2222-2222-222222222222');
  INSERT INTO public.spots (id, user_id, name, latitude, longitude)
  VALUES ('33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222', '退会テスト', 35.1, 139.5);
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, catch_count)
  VALUES ('22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333', '2026-07-29', 1);

  DELETE FROM auth.users WHERE id = '22222222-2222-2222-2222-222222222222';

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '22222222-2222-2222-2222-222222222222')
     OR EXISTS (SELECT 1 FROM public.spots WHERE user_id = '22222222-2222-2222-2222-222222222222')
     OR EXISTS (SELECT 1 FROM public.fishing_records WHERE user_id = '22222222-2222-2222-2222-222222222222')
     OR EXISTS (SELECT 1 FROM public.methods WHERE user_id = '22222222-2222-2222-2222-222222222222')
  THEN
    RAISE EXCEPTION 'TEST FAIL: 退会後に個人データが残っている';
  END IF;

  -- 通常のスポット削除ガードは維持されていること（確定仕様書 17.2 章）
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, 'ガード再確認', 35.2, 139.6) RETURNING id INTO spot_tokyo;
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, catch_count)
  VALUES (u, spot_tokyo, '2026-07-13', 1);
  BEGIN
    DELETE FROM public.spots WHERE id = spot_tokyo;
    failed := TRUE;
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 退会対応後にスポット削除ガードが効かなくなった';
  END IF;

  ------------------------------------------------------------
  -- 魚種 seed の冪等性（002 の再実行相当）
  ------------------------------------------------------------
  INSERT INTO public.fish_species (user_id, name, category)
  VALUES (NULL, 'ブリ', '海水')
  ON CONFLICT (user_id, name) DO NOTHING;
  IF (SELECT COUNT(*) FROM public.fish_species WHERE user_id IS NULL AND name = 'ブリ') <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: システムデフォルト魚種が重複する';
  END IF;

  ------------------------------------------------------------
  -- 魚種マスタの並び順（006）
  ------------------------------------------------------------
  -- 追加した 7 種がシステムデフォルトとして揃っていること
  IF (SELECT COUNT(*) FROM public.fish_species
      WHERE user_id IS NULL
        AND name IN ('アジ', 'メバル', 'カサゴ', 'カマス', 'キス', 'タコ', 'イカ')) <> 7 THEN
    RAISE EXCEPTION 'TEST FAIL: 追加した魚種が揃っていない';
  END IF;

  -- 全システムデフォルトに水域区分と並び順が入っていること
  IF EXISTS (SELECT 1 FROM public.fish_species
             WHERE user_id IS NULL
               AND (sort_order IS NULL OR category NOT IN ('海水', '汽水', '淡水'))) THEN
    RAISE EXCEPTION 'TEST FAIL: 並び順または水域区分が未設定の魚種がある';
  END IF;

  -- 同一水域内で並び順が一意（隣接指定が崩れない）
  IF EXISTS (SELECT 1 FROM public.fish_species
             WHERE user_id IS NULL
             GROUP BY category, sort_order HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'TEST FAIL: 同一水域で並び順が重複している';
  END IF;

  -- 近縁種が隣接していること（マルスズキ/ヒラスズキ・クロダイ/キビレ）
  IF (SELECT b.sort_order - a.sort_order
      FROM public.fish_species a, public.fish_species b
      WHERE a.user_id IS NULL AND a.name = 'マルスズキ'
        AND b.user_id IS NULL AND b.name = 'ヒラスズキ'
        AND a.category = b.category) IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'TEST FAIL: マルスズキとヒラスズキが隣接していない';
  END IF;
  IF (SELECT b.sort_order - a.sort_order
      FROM public.fish_species a, public.fish_species b
      WHERE a.user_id IS NULL AND a.name = 'クロダイ'
        AND b.user_id IS NULL AND b.name = 'キビレ'
        AND a.category = '汽水' AND b.category = '汽水') IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'TEST FAIL: クロダイとキビレが汽水で隣接していない';
  END IF;

  ------------------------------------------------------------
  -- 潮汐地点の細分化（007・浜名湖の時差補正）
  ------------------------------------------------------------
  -- 静岡県の潮位表地点が 10 点そろっていること
  IF (SELECT COUNT(*) FROM public.tide_stations WHERE pref = '静岡県') <> 10 THEN
    RAISE EXCEPTION 'TEST FAIL: 静岡県の観測点が 10 点でない（実際: %）',
      (SELECT COUNT(*) FROM public.tide_stations WHERE pref = '静岡県');
  END IF;

  -- 浜名湖の細分地点はすべて舞阪基準で、時差が 0〜3 時間の範囲
  IF EXISTS (SELECT 1 FROM public.tide_areas
             WHERE water_body = '浜名湖'
               AND (base_station_code <> 'MI' OR lag_minutes NOT BETWEEN 0 AND 180)) THEN
    RAISE EXCEPTION 'TEST FAIL: 浜名湖の潮汐地点の基準観測点または時差が不正';
  END IF;

  -- 出典どおりの時差になっていること（村櫛 2 時間 / 細江湖・猪鼻瀬戸 3 時間 / 湖口 0）
  IF (SELECT lag_minutes FROM public.tide_areas WHERE code = 'HN-MURAKUSHI') <> 120
     OR (SELECT lag_minutes FROM public.tide_areas WHERE code = 'HN-HOSOE') <> 180
     OR (SELECT lag_minutes FROM public.tide_areas WHERE code = 'HN-SETO') <> 180
     OR (SELECT lag_minutes FROM public.tide_areas WHERE code = 'HN-IMAGIRI') <> 0 THEN
    RAISE EXCEPTION 'TEST FAIL: 浜名湖の時差が出典と一致しない';
  END IF;

  -- 湖内スポットは細分地点が自動設定される（村櫛のすぐ近く）
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '村櫛の近く', 34.7190, 137.5940) RETURNING id INTO spot_target;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_target)
     IS DISTINCT FROM 'HN-MURAKUSHI' THEN
    RAISE EXCEPTION 'TEST FAIL: 浜名湖内スポットに潮汐地点が自動設定されない（実際: %）',
      (SELECT tide_area_code FROM public.spots WHERE id = spot_target);
  END IF;
  -- 基準観測点としては舞阪が入ること
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_target) IS DISTINCT FROM 'MI' THEN
    RAISE EXCEPTION 'TEST FAIL: 浜名湖内スポットの観測点が舞阪でない';
  END IF;

  -- 湖から離れた場所（御前崎沖）では細分地点を付けない
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '御前崎の近く', 34.6200, 138.2200) RETURNING id INTO spot_fresh;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_fresh) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 浜名湖圏外で潮汐地点が付いてしまう';
  END IF;

  -- 淡水スポットは潮汐地点も NULL になること
  UPDATE public.spots SET water_type = 'freshwater' WHERE id = spot_target;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_target) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 淡水化しても潮汐地点が残る';
  END IF;

  -- 潮汐地点を明示指定した UPDATE では自動割り当てが優先しないこと
  -- （観測点 tide_station_code と同じ扱い。座標だけを後から動かせば再計算される）
  UPDATE public.spots
  SET water_type = 'saltwater', latitude = 34.6817, longitude = 137.5839,
      tide_area_code = 'HN-KIGA'
  WHERE id = spot_target;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_target) IS DISTINCT FROM 'HN-KIGA' THEN
    RAISE EXCEPTION 'TEST FAIL: 潮汐地点の明示指定が上書きされる';
  END IF;

  -- 座標だけを動かしたときは最近傍で再計算される
  UPDATE public.spots SET latitude = 34.7856, longitude = 137.6108 WHERE id = spot_target;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_target) IS DISTINCT FROM 'HN-HOSOE' THEN
    RAISE EXCEPTION 'TEST FAIL: 座標変更で潮汐地点が再計算されない（実際: %）',
      (SELECT tide_area_code FROM public.spots WHERE id = spot_target);
  END IF;

  -- NULL に戻すと「自動で決める」として再計算される（UI の既定選択）
  UPDATE public.spots SET tide_area_code = NULL WHERE id = spot_target;
  IF (SELECT tide_area_code FROM public.spots WHERE id = spot_target) IS DISTINCT FROM 'HN-HOSOE' THEN
    RAISE EXCEPTION 'TEST FAIL: NULL 指定で自動割り当てに戻らない（実際: %）',
      (SELECT tide_area_code FROM public.spots WHERE id = spot_target);
  END IF;
  UPDATE public.spots SET tide_station_code = NULL WHERE id = spot_target;
  IF (SELECT tide_station_code FROM public.spots WHERE id = spot_target) IS DISTINCT FROM 'MI' THEN
    RAISE EXCEPTION 'TEST FAIL: 観測点も NULL 指定で自動割り当てに戻らない';
  END IF;

  ------------------------------------------------------------
  -- スポット座標のガード（008）
  ------------------------------------------------------------
  -- (0,0) は弾かれること（Open-Meteo が別の場所の日の出日没を返してしまうため）
  BEGIN
    INSERT INTO public.spots (user_id, name, latitude, longitude)
    VALUES (u, '座標なし', 0, 0);
    failed := TRUE;
  EXCEPTION WHEN check_violation THEN
    NULL;  -- 期待どおり
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: (0,0) のスポットが登録できてしまう';
  END IF;

  -- 国外の座標も弾かれること
  BEGIN
    INSERT INTO public.spots (user_id, name, latitude, longitude)
    VALUES (u, 'ハワイ', 21.3, -157.8);
    failed := TRUE;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 国外の座標が登録できてしまう';
  END IF;

  -- 国内の座標は通ること（境界に近い与那国島・南鳥島も含む）
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (u, '与那国島', 24.45, 123.00), (u, '南鳥島', 24.29, 153.98);

  ------------------------------------------------------------
  -- お気に入りの潮汐地点（009）
  ------------------------------------------------------------
  -- 既定は空配列
  IF (SELECT favorite_tide_points FROM public.profiles WHERE id = u) IS DISTINCT FROM '{}' THEN
    RAISE EXCEPTION 'TEST FAIL: favorite_tide_points の既定が空配列でない';
  END IF;

  -- 正しい形式は保存できる
  UPDATE public.profiles
  SET favorite_tide_points = ARRAY['ST:MI', 'AR:HN-MURAKUSHI'] WHERE id = u;
  IF array_length((SELECT favorite_tide_points FROM public.profiles WHERE id = u), 1) <> 2 THEN
    RAISE EXCEPTION 'TEST FAIL: お気に入りの潮汐地点が保存できない';
  END IF;

  -- 形式が違う値は弾かれる（タブが壊れるため）
  BEGIN
    UPDATE public.profiles SET favorite_tide_points = ARRAY['MI'] WHERE id = u;
    failed := TRUE;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 形式の違うお気に入りが保存できてしまう';
  END IF;

  -- 空配列に戻せる
  UPDATE public.profiles SET favorite_tide_points = '{}' WHERE id = u;

  RAISE NOTICE 'ALL DB TESTS PASSED';
END;
$$;
