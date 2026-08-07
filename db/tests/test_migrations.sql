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

-- ============================================================
-- 010: グループ共有と招待
-- ビュー record_feed は RLS を迂回して動くため、WHERE 句が認可そのもの。
-- 「見えるべきものが見える」だけでなく「見えてはいけないものが見えない」を
-- 明示的に検証する。
-- ============================================================
INSERT INTO auth.users (id) VALUES
  ('22222222-2222-2222-2222-222222222222'),   -- 招待した友人
  ('33333333-3333-3333-3333-333333333333');   -- 無関係の他人

-- 012 以降、グループ作成と招待は管理者だけ。テストの主体を管理者にしておく。
INSERT INTO public.app_admins (user_id, note)
VALUES ('11111111-1111-1111-1111-111111111111', 'テスト用の管理者')
ON CONFLICT (user_id) DO NOTHING;

DO $$
DECLARE
  owner_id  CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  friend_id CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  other_id  CONSTANT UUID := '33333333-3333-3333-3333-333333333333';
  gid            UUID;
  invite         UUID;
  claimed        UUID;
  owner_spot     UUID;
  friend_spot    UUID;
  friend_public  UUID;
  friend_private UUID;
  other_public   UUID;
  visible        INTEGER;
  failed         BOOLEAN := FALSE;
BEGIN
  UPDATE public.profiles SET username = 'オーナー' WHERE id = owner_id;
  UPDATE public.profiles SET username = 'たろう'   WHERE id = friend_id;
  -- other_id は username 未設定のまま（display_name の既定値を確認する）

  INSERT INTO public.groups (name, owner_id) VALUES ('テスト班', owner_id)
    RETURNING id INTO gid;
  -- handle_new_group がオーナーを自動登録する
  IF (SELECT COUNT(*) FROM public.group_members WHERE group_id = gid) <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: グループ作成時にオーナーが登録されない';
  END IF;

  ------------------------------------------------------------
  -- 招待の下見 → 確保 → 使用
  ------------------------------------------------------------
  INSERT INTO public.group_invites (group_id, created_by, label)
  VALUES (gid, owner_id, 'たろう') RETURNING token INTO invite;

  IF NOT (SELECT valid FROM public.peek_invite(invite)) THEN
    RAISE EXCEPTION 'TEST FAIL: 有効な招待が無効と判定される';
  END IF;
  IF (SELECT inviter FROM public.peek_invite(invite)) <> 'オーナー' THEN
    RAISE EXCEPTION 'TEST FAIL: 招待者の表示名が違う';
  END IF;
  IF (SELECT valid FROM public.peek_invite(gen_random_uuid())) THEN
    RAISE EXCEPTION 'TEST FAIL: 存在しないトークンが有効になる';
  END IF;

  claimed := public.claim_invite(invite);
  IF claimed IS DISTINCT FROM gid THEN
    RAISE EXCEPTION 'TEST FAIL: 招待を確保できない';
  END IF;
  -- 2 回目は確保できない（同じリンクを 2 人が開いた場合）
  IF public.claim_invite(invite) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 同じ招待を 2 回確保できてしまう';
  END IF;
  -- 戻せば再度使える
  PERFORM public.release_invite(invite);
  IF public.claim_invite(invite) IS DISTINCT FROM gid THEN
    RAISE EXCEPTION 'TEST FAIL: release_invite 後に再確保できない';
  END IF;

  PERFORM public.redeem_invite(invite, friend_id);
  IF NOT EXISTS (SELECT 1 FROM public.group_members
                 WHERE group_id = gid AND user_id = friend_id AND role = 'member') THEN
    RAISE EXCEPTION 'TEST FAIL: 招待を使ってもメンバーにならない';
  END IF;
  IF (SELECT used_by FROM public.group_invites WHERE token = invite) <> friend_id THEN
    RAISE EXCEPTION 'TEST FAIL: 招待の使用者が記録されない';
  END IF;
  -- 使用済みの招待は下見でも弾かれる
  IF (SELECT valid FROM public.peek_invite(invite)) THEN
    RAISE EXCEPTION 'TEST FAIL: 使用済みの招待が有効なまま';
  END IF;

  -- 期限切れ
  INSERT INTO public.group_invites (group_id, created_by, expires_at)
  VALUES (gid, owner_id, NOW() - INTERVAL '1 day') RETURNING token INTO invite;
  IF (SELECT valid FROM public.peek_invite(invite)) THEN
    RAISE EXCEPTION 'TEST FAIL: 期限切れの招待が有効なまま';
  END IF;
  IF public.claim_invite(invite) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 期限切れの招待を確保できてしまう';
  END IF;

  ------------------------------------------------------------
  -- 釣果の共有範囲
  ------------------------------------------------------------
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (owner_id, 'オーナーの港', 34.70, 137.60) RETURNING id INTO owner_spot;
  INSERT INTO public.spots (user_id, name, latitude, longitude)
  VALUES (friend_id, 'たろうの磯', 34.71, 137.61) RETURNING id INTO friend_spot;

  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, visibility, memo)
  VALUES (friend_id, friend_spot, DATE '2026-08-01', 'group', 'たろうの公開')
  RETURNING id INTO friend_public;
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, visibility, memo)
  VALUES (friend_id, friend_spot, DATE '2026-08-02', 'private', 'たろうの非公開')
  RETURNING id INTO friend_private;
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, visibility, memo)
  VALUES (other_id, NULL, DATE '2026-08-03', 'group', '無関係の人の公開')
  RETURNING id INTO other_public;
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, visibility)
  VALUES (owner_id, owner_spot, DATE '2026-08-04', 'private');

  -- オーナーとして見る
  PERFORM set_config('request.jwt.claim.sub', owner_id::TEXT, TRUE);

  -- 自分の釣果は公開範囲によらず全件見える（前の DO ブロックで作った分も含む）
  IF (SELECT COUNT(*) FROM public.record_feed WHERE user_id = owner_id)
     <> (SELECT COUNT(*) FROM public.fishing_records WHERE user_id = owner_id) THEN
    RAISE EXCEPTION 'TEST FAIL: 自分の釣果が全件見えていない';
  END IF;
  -- 他人の分はたろうの公開 1 件だけ
  SELECT COUNT(*) INTO visible FROM public.record_feed WHERE user_id <> owner_id;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の釣果が % 件見えている（たろうの公開 1 件のはず）', visible;
  END IF;
  IF EXISTS (SELECT 1 FROM public.record_feed WHERE id = friend_private) THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の「自分のみ」の釣果が見えてしまう';
  END IF;
  IF EXISTS (SELECT 1 FROM public.record_feed WHERE id = other_public) THEN
    RAISE EXCEPTION 'TEST FAIL: 同じグループでない人の釣果が見えてしまう';
  END IF;

  -- 他人の行は is_mine = false で、名前とスポット名が付く
  IF (SELECT is_mine FROM public.record_feed WHERE id = friend_public) THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の釣果が is_mine になっている';
  END IF;
  IF (SELECT owner_name FROM public.record_feed WHERE id = friend_public) <> 'たろう' THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の釣果に投稿者名が付かない';
  END IF;
  IF (SELECT spot_name FROM public.record_feed WHERE id = friend_public) <> 'たろうの磯' THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の釣果にスポット名が付かない';
  END IF;

  -- 座標も共有する（011）。ただし共有の条件は変わらない
  IF (SELECT spot_latitude FROM public.record_feed WHERE id = friend_public) IS NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 共有された釣果にスポットの座標が付かない';
  END IF;
  -- 非公開の釣果は行ごと出ないので、そのスポットの座標も出ない
  IF EXISTS (SELECT 1 FROM public.record_feed WHERE spot_id IS NOT NULL
               AND user_id <> owner_id AND visibility <> 'group') THEN
    RAISE EXCEPTION 'TEST FAIL: 非公開の釣果からスポットが漏れている';
  END IF;

  -- メンバー一覧
  IF (SELECT COUNT(*) FROM public.group_member_names WHERE group_id = gid) <> 2 THEN
    RAISE EXCEPTION 'TEST FAIL: メンバー一覧が 2 件にならない';
  END IF;

  -- 無関係の人として見る
  PERFORM set_config('request.jwt.claim.sub', other_id::TEXT, TRUE);
  SELECT COUNT(*) INTO visible FROM public.record_feed WHERE user_id <> other_id;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'TEST FAIL: グループ外の人に他人の釣果が % 件見えている', visible;
  END IF;
  IF (SELECT owner_name FROM public.record_feed WHERE id = other_public) <> 'メンバー' THEN
    RAISE EXCEPTION 'TEST FAIL: username 未設定時の表示名が既定にならない';
  END IF;
  IF (SELECT COUNT(*) FROM public.group_member_names) <> 0 THEN
    RAISE EXCEPTION 'TEST FAIL: グループ外の人にメンバー一覧が見えている';
  END IF;

  -- 未ログイン（auth.uid() が NULL）では何も見えない
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  IF (SELECT COUNT(*) FROM public.record_feed) <> 0 THEN
    RAISE EXCEPTION 'TEST FAIL: 未ログインで釣果が見えている';
  END IF;

  ------------------------------------------------------------
  -- 人数上限
  ------------------------------------------------------------
  FOR i IN 1..public.group_member_limit() LOOP
    INSERT INTO auth.users (id) VALUES (gen_random_uuid());
  END LOOP;
  BEGIN
    INSERT INTO public.group_members (group_id, user_id, role)
    SELECT gid, u.id, 'member' FROM auth.users u
     WHERE u.id NOT IN (SELECT user_id FROM public.group_members WHERE group_id = gid);
    failed := TRUE;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 人数上限を超えてメンバーを追加できてしまう';
  END IF;

  RAISE NOTICE 'GROUP SHARING TESTS PASSED';
END;
$$;

-- 招待を使って入った人が退会できること（外部キーが退会を妨げない）
DO $$
DECLARE
  leaver UUID := gen_random_uuid();
  gid    UUID;
  tok    UUID;
BEGIN
  INSERT INTO auth.users (id) VALUES (leaver);
  SELECT id INTO gid FROM public.groups WHERE name = 'テスト班';
  INSERT INTO public.group_invites (group_id, created_by)
  VALUES (gid, '11111111-1111-1111-1111-111111111111') RETURNING token INTO tok;
  UPDATE public.group_invites SET used_by = leaver, used_at = NOW() WHERE token = tok;

  DELETE FROM auth.users WHERE id = leaver;   -- profiles へ CASCADE する
  IF (SELECT used_by FROM public.group_invites WHERE token = tok) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 退会しても招待の使用者が残っている';
  END IF;
  RAISE NOTICE 'INVITE FK TESTS PASSED';
END;
$$;

-- ============================================================
-- 012: 招待できるのは管理者だけ
-- 「画面にボタンが無い」ではなく、DB として塞がっていることを確認する。
-- ============================================================
DO $$
DECLARE
  admin_id  CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  friend_id CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  gid       UUID;
  failed    BOOLEAN := FALSE;
BEGIN
  SELECT id INTO gid FROM public.groups WHERE name = 'テスト班';

  -- 未ログイン（auth.uid() が NULL）は管理者ではない
  IF public.is_app_admin() THEN
    RAISE EXCEPTION 'TEST FAIL: 未ログインで管理者判定が true';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', admin_id::TEXT, TRUE);
  IF NOT public.is_app_admin() THEN
    RAISE EXCEPTION 'TEST FAIL: 管理者が管理者と判定されない';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', friend_id::TEXT, TRUE);
  IF public.is_app_admin() THEN
    RAISE EXCEPTION 'TEST FAIL: 招待された人が管理者になっている';
  END IF;

  -- 管理者は招待を作れる
  PERFORM set_config('request.jwt.claim.sub', admin_id::TEXT, TRUE);
  INSERT INTO public.group_invites (group_id, created_by, label)
  VALUES (gid, admin_id, '管理者から');

  -- 招待された人（オーナーでもない）は作れない — トリガー側
  BEGIN
    INSERT INTO public.group_invites (group_id, created_by)
    VALUES (gid, friend_id);
    failed := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 管理者でない人が招待を作れてしまう';
  END IF;

  -- 管理者でも、オーナーでないグループには作れない
  BEGIN
    INSERT INTO public.group_invites (group_id, created_by)
    SELECT g.id, admin_id FROM public.groups g WHERE g.owner_id <> admin_id LIMIT 1;
    IF FOUND THEN failed := TRUE; END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: オーナーでないグループに招待を作れてしまう';
  END IF;

  RAISE NOTICE 'ADMIN INVITE TESTS PASSED';
END;
$$;

-- RLS ポリシーそのものの検証（上の DO ブロックはテーブル所有者権限で走るため
-- RLS が効かない。実際のアプリと同じ authenticated ロールで確かめる）。
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
REVOKE ALL ON public.app_admins FROM authenticated;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- 招待された人

DO $$
DECLARE
  friend_id CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  gid       UUID;
  failed    BOOLEAN := FALSE;
BEGIN
  SELECT id INTO gid FROM public.groups WHERE name = 'テスト班';

  -- ① 自分を created_by にして招待を作る（010 で空いていた穴）
  BEGIN
    INSERT INTO public.group_invites (group_id, created_by) VALUES (gid, friend_id);
    failed := TRUE;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: メンバーが RLS を通って招待を作れてしまう';
  END IF;

  -- ② 自分のグループを新規に作って、そのオーナーとして招待する（もう 1 つの穴）
  BEGIN
    INSERT INTO public.groups (name, owner_id) VALUES ('抜け道グループ', friend_id);
    failed := TRUE;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: メンバーが自分のグループを作れてしまう';
  END IF;

  -- ③ 管理者台帳そのものを触る
  BEGIN
    PERFORM 1 FROM public.app_admins;
    failed := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 管理者台帳がアプリから読めてしまう';
  END IF;

  RAISE NOTICE 'INVITE RLS TESTS PASSED';
END;
$$;

-- 対照実験: 同じ authenticated ロールでも管理者なら通ること。
-- これが無いと、上の 3 つが「権限不足以外の理由」で失敗していても
-- テストが通ってしまう（GRANT 漏れなどを拒否と読み違えない）。
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';   -- 管理者

DO $$
DECLARE
  admin_id CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  gid      UUID;
BEGIN
  SELECT id INTO gid FROM public.groups WHERE name = 'テスト班';
  INSERT INTO public.group_invites (group_id, created_by, label)
  VALUES (gid, admin_id, 'authenticated ロールから');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAIL: 管理者が authenticated ロールで招待を作れない';
  END IF;
  RAISE NOTICE 'INVITE RLS CONTROL PASSED';
END;
$$;

RESET ROLE;

-- ============================================================
-- 013: 釣れた時刻
-- ============================================================
DO $$
DECLARE
  owner_id CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  rec      UUID;
  spot     UUID;
BEGIN
  SELECT id INTO spot FROM public.spots WHERE user_id = owner_id LIMIT 1;

  -- 時刻は任意（既存の記録は NULL のまま）
  INSERT INTO public.fishing_records (user_id, spot_id, fished_at, visibility)
  VALUES (owner_id, spot, DATE '2026-08-05', 'private') RETURNING id INTO rec;
  IF (SELECT fished_time FROM public.fishing_records WHERE id = rec) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAIL: 時刻の既定が NULL でない';
  END IF;

  -- 時刻を入れられる。日をまたぐ夜釣り（03:20）も普通に入る
  UPDATE public.fishing_records SET fished_time = TIME '03:20' WHERE id = rec;

  PERFORM set_config('request.jwt.claim.sub', owner_id::TEXT, TRUE);
  IF (SELECT fished_time FROM public.record_feed WHERE id = rec) <> TIME '03:20' THEN
    RAISE EXCEPTION 'TEST FAIL: record_feed に時刻が出ない';
  END IF;

  -- 共有された釣果でも潮位を引けるよう、スポットの潮汐地点が出ること
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'record_feed'
       AND column_name IN ('spot_tide_station_code', 'spot_tide_area_code')
    HAVING COUNT(*) = 2
  ) THEN
    RAISE EXCEPTION 'TEST FAIL: record_feed に潮汐地点の列が無い';
  END IF;

  -- ビューがスポットの値をそのまま通していること
  -- （どの観測点が付くかは 004 / 007 の責務なので、ここでは一致だけを見る）
  IF EXISTS (
    SELECT 1 FROM public.record_feed f JOIN public.spots sp ON sp.id = f.spot_id
     WHERE f.id = rec
       AND (f.spot_tide_station_code IS DISTINCT FROM sp.tide_station_code
         OR f.spot_tide_area_code    IS DISTINCT FROM sp.tide_area_code)
  ) THEN
    RAISE EXCEPTION 'TEST FAIL: スポットの潮汐地点がビューと一致しない';
  END IF;

  DELETE FROM public.fishing_records WHERE id = rec;
  RAISE NOTICE 'FISHED TIME TESTS PASSED';
END;
$$;

-- ============================================================
-- 014: 釣果写真
-- 非公開バケット + 台帳。共有範囲は釣果と同じ（見える釣果の写真だけ見える）。
-- ============================================================
DO $$
DECLARE
  owner_id  CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  friend_id CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  other_id  CONSTANT UUID := '33333333-3333-3333-3333-333333333333';
  pub_rec   UUID;
  priv_rec  UUID;
  spot      UUID;
  failed    BOOLEAN := FALSE;
BEGIN
  IF (SELECT public FROM storage.buckets WHERE id = 'catch-photos') THEN
    RAISE EXCEPTION 'TEST FAIL: 写真のバケットが公開になっている';
  END IF;

  SELECT id INTO spot FROM public.spots WHERE user_id = friend_id LIMIT 1;
  SELECT id INTO pub_rec FROM public.fishing_records
   WHERE user_id = friend_id AND visibility = 'group' LIMIT 1;
  SELECT id INTO priv_rec FROM public.fishing_records
   WHERE user_id = friend_id AND visibility = 'private' LIMIT 1;

  INSERT INTO public.record_photos (record_id, user_id, path, thumb_path, width, height, bytes)
  VALUES (pub_rec,  friend_id, friend_id || '/a.webp', friend_id || '/a_t.webp', 1600, 1200, 210000),
         (priv_rec, friend_id, friend_id || '/b.webp', friend_id || '/b_t.webp', 1600, 1200, 190000);

  -- 同じグループのオーナーから見る
  PERFORM set_config('request.jwt.claim.sub', owner_id::TEXT, TRUE);
  IF NOT public.photo_visible_to_me(friend_id || '/a.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: 共有された釣果の写真が見えない';
  END IF;
  IF NOT public.photo_visible_to_me(friend_id || '/a_t.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: サムネイルが見えない';
  END IF;
  IF public.photo_visible_to_me(friend_id || '/b.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: 非公開の釣果の写真が見えてしまう';
  END IF;

  -- グループ外の人から見る
  PERFORM set_config('request.jwt.claim.sub', other_id::TEXT, TRUE);
  IF public.photo_visible_to_me(friend_id || '/a.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: グループ外の人に写真が見えてしまう';
  END IF;

  -- 未ログイン
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  IF public.photo_visible_to_me(friend_id || '/a.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: 未ログインで写真が見えてしまう';
  END IF;

  -- 台帳に無いパスは誰にも見えない（署名付き URL の総当たり対策）
  PERFORM set_config('request.jwt.claim.sub', owner_id::TEXT, TRUE);
  IF public.photo_visible_to_me(friend_id || '/unknown.webp') THEN
    RAISE EXCEPTION 'TEST FAIL: 台帳に無いパスが見えてしまう';
  END IF;

  -- 釣果を消すと台帳も消える
  DELETE FROM public.fishing_records WHERE id = priv_rec;
  IF EXISTS (SELECT 1 FROM public.record_photos WHERE record_id = priv_rec) THEN
    RAISE EXCEPTION 'TEST FAIL: 釣果を消しても写真の台帳が残る';
  END IF;

  -- 一覧用に 1 枚目のサムネイルが出る
  PERFORM set_config('request.jwt.claim.sub', owner_id::TEXT, TRUE);
  IF (SELECT photo_thumb_path FROM public.record_feed WHERE id = pub_rec)
     IS DISTINCT FROM friend_id || '/a_t.webp' THEN
    RAISE EXCEPTION 'TEST FAIL: record_feed にサムネイルが出ない';
  END IF;
  IF (SELECT photo_count FROM public.record_feed WHERE id = pub_rec) <> 1 THEN
    RAISE EXCEPTION 'TEST FAIL: 写真の枚数が合わない';
  END IF;

  RAISE NOTICE 'CATCH PHOTO TESTS PASSED';
END;
$$;

-- RLS も authenticated ロールで確かめる
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';   -- 他人（グループ内）

DO $$
DECLARE
  friend_id CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  pub_rec   UUID;
  failed    BOOLEAN := FALSE;
BEGIN
  SELECT record_id INTO pub_rec FROM public.record_photos LIMIT 1;

  -- 読めるが、他人の写真は消せない
  IF NOT EXISTS (SELECT 1 FROM public.record_photos) THEN
    RAISE EXCEPTION 'TEST FAIL: 共有された写真が読めない';
  END IF;
  DELETE FROM public.record_photos WHERE user_id = friend_id;
  IF NOT EXISTS (SELECT 1 FROM public.record_photos WHERE user_id = friend_id) THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の写真を消せてしまう';
  END IF;

  -- 他人の釣果に写真をぶら下げられない
  BEGIN
    INSERT INTO public.record_photos (record_id, user_id, path, thumb_path)
    VALUES (pub_rec, '11111111-1111-1111-1111-111111111111', 'x/c.webp', 'x/c_t.webp');
    failed := TRUE;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    NULL;
  END;
  IF failed THEN
    RAISE EXCEPTION 'TEST FAIL: 他人の釣果に写真を追加できてしまう';
  END IF;

  RAISE NOTICE 'CATCH PHOTO RLS TESTS PASSED';
END;
$$;

RESET ROLE;
