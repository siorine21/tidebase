-- ============================================================
-- タックル名を変えたら、釣果に残っている名前も一緒に付け替える
--
-- 報告（2026-08-09）: 登録したタックル名で釣果に紐付いてしまっているので、
--   消して付け直すのは現実的に難しい。名前を編集できるようにしてほしい。
--
-- D-066 では「釣果側は文字列で持つ。あとで登録名を変えても当時の記録は変わらない」
-- と書いたが、**この判断はタックルには当てはまらなかった**。
--   釣った魚の呼称やルアー種別は「そのとき何だったか」の記録なので、
--   あとから変えてはいけない。
--   一方タックル名は**持ち物につけた名前**であって、釣行時の事実ではない。
--   打ち間違いを直したり、型番まで正確に書き直したりしたら、
--   過去の釣果も同じものを指していてほしい。改名であって、履歴の改ざんではない。
--
-- 2 つの UPDATE を別々に投げると、片方だけ通って食い違う。
-- 1 つの関数にまとめて、まとめて成功かまとめて失敗にする。
-- SECURITY DEFINER にはしない（RLS を効かせたまま、自分の行しか触れない）。
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rename_tackle(p_kind TEXT, p_old TEXT, p_new TEXT)
RETURNS INTEGER          -- 名前を付け替えた釣果の件数
LANGUAGE plpgsql
AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_new   TEXT := btrim(p_new);
  v_count INTEGER := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'ログインしていません';
  END IF;
  -- 列名に使うので、必ず固定の候補から選ばせる（format(%I) の前に弾く）
  IF p_kind NOT IN ('rod', 'reel', 'line', 'leader') THEN
    RAISE EXCEPTION '不明なタックル種別です: %', p_kind;
  END IF;
  IF v_new = '' THEN
    RAISE EXCEPTION '名前を入力してください';
  END IF;
  IF v_new = p_old THEN
    RETURN 0;
  END IF;

  -- 変更先の名前がすでにあるなら、そちらへまとめる（重複を作らない）
  IF EXISTS (
    SELECT 1 FROM public.tackle_items t
    WHERE t.user_id = v_user AND t.kind = p_kind AND t.name = v_new
  ) THEN
    DELETE FROM public.tackle_items t
    WHERE t.user_id = v_user AND t.kind = p_kind AND t.name = p_old;
  ELSE
    UPDATE public.tackle_items t SET name = v_new
    WHERE t.user_id = v_user AND t.kind = p_kind AND t.name = p_old;
  END IF;

  -- ここが本題。釣果に残っている名前も付け替える（自分の釣果だけ）
  EXECUTE format(
    'UPDATE public.fishing_records SET %I = $1 WHERE user_id = $2 AND %I = $3',
    p_kind, p_kind
  ) USING v_new, v_user, p_old;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.rename_tackle(TEXT, TEXT, TEXT) IS
  'タックル名の変更。釣果に残っている名前も同時に付け替える（D-067）。'
  'RLS はそのまま効くので、自分の行しか変わらない。';

REVOKE ALL ON FUNCTION public.rename_tackle(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_tackle(TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
