-- ============================================================
-- 033: 権限の穴を 2 つ塞ぐ（安全点検 2026-08-16 / D-124）
--
--  ① copy_default_methods が anon / authenticated から実行できた。
--     SECURITY DEFINER（＝所有者権限で走り RLS を素通りする）うえに、
--     **書き込む相手を呼び出し側が指定できる**ので、
--     ログインしていない第三者でも、実在する利用者 ID さえ分かれば
--     その人の methods に行を書き足せた。
--     実際に公開キーだけで叩いて確認した（外部キー違反 23503 まで到達する
--     ＝権限では止まっていない）。呼び出し元は handle_new_user
--     トリガーだけなので、剥がしても登録の動きは変わらない。
--
--  ② record_feed / spot_feed / tide_correlation に、anon まで含めて
--     ALL 権限が付いていた。
--     **これは一度直したものが戻っている。** 010 / 011 / 013 / 014 / 024 で
--     REVOKE しているが、016 / 025 / 031 / 032 が DROP VIEW → CREATE VIEW で
--     作り直しており、そのとき ACL が初期化されて既定の権限が戻る。
--     security_invoker = false は毎回きちんと書き写されていたのに、
--     権限のほうだけ落ちていた。spot_feed（020 / 028）は最初から一度も
--     REVOKE していない。
--
--     いまは 3 つとも複数テーブルの結合で更新可能ビューではないため、
--     書き込みは実際には通らない（information_schema.views の
--     is_updatable = NO で確認）。**たまたま守られている**状態なので、
--     定義を単純化した瞬間に RLS を回り込む書き込み経路になる。
--
--  この 033 も将来また剥がれうる。**再発は db/tests/test_migrations.sql の
--  検査で止める**（ビューを作り直したら authenticated の SELECT が消えるので
--  そこで落ちる）。ビューを触るマイグレーションを書くときは、
--  **定義のすぐ下にこの権限 3 行を必ず書き写すこと。**
-- ============================================================

-- ------------------------------------------------------------
-- ① SECURITY DEFINER 関数をブラウザ側の 2 ロールから隠す
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.copy_default_methods(UUID)
  FROM PUBLIC, anon, authenticated;

-- 探索パスを固定する。中の参照は public. で修飾済みなので現状の実害は無いが、
-- SECURITY DEFINER には例外なく付ける（010 の補助関数と同じ扱いにそろえる）。
ALTER FUNCTION public.copy_default_methods(UUID) SET search_path = public;
ALTER FUNCTION public.handle_new_user()          SET search_path = public;

COMMENT ON FUNCTION public.copy_default_methods(UUID) IS
  '新規登録時に既定メソッドを複製する。**handle_new_user トリガー専用。**'
  ' 書き込む相手を引数で受け取る SECURITY DEFINER なので、'
  ' ブラウザ側のロール（anon / authenticated）には絶対に EXECUTE を与えないこと（033）。';

-- ------------------------------------------------------------
-- ② ビューは「ログイン済みの読み取り」だけに絞る
-- ------------------------------------------------------------
REVOKE ALL ON public.record_feed       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.spot_feed         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tide_correlation  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.record_feed      TO authenticated;
GRANT SELECT ON public.spot_feed        TO authenticated;
GRANT SELECT ON public.tide_correlation TO authenticated;

COMMENT ON VIEW public.tide_correlation IS
  '潮回りごとの釣行・釣果の集計。security_invoker = true なので、'
  ' 見える範囲は fishing_records の RLS が決める（WHERE 句には利用者の条件が無い）。'
  ' 権限は authenticated の SELECT だけ（033）。';
