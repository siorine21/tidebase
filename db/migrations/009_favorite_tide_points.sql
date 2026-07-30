-- ============================================================
-- お気に入りの潮汐地点（SCR-003 の地点切替タブ）
--
-- ワイヤーフレーム v7.2 の SCR-003 は「お気に入り地点」を横スクロールの
-- タブで切り替える。端末をまたいで同じ並びにしたいので localStorage ではなく
-- profiles に持たせる（ホームの「今どの地点を見ているか」は端末ごとの状態なので
-- localStorage のままにする）。
--
-- 値は listTidePoints() の value と同じ形式:
--   "ST:<地点記号>"  … 気象庁の潮位表地点（例 ST:MI）
--   "AR:<地点コード>" … 細分した潮汐地点（例 AR:HN-MURAKUSHI）
-- 参照整合性は取れない（2 つのテーブルにまたがるため）。存在しない値は
-- 画面側で読み飛ばす。
-- ============================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS favorite_tide_points TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.profiles.favorite_tide_points IS
  'SCR-003 の地点切替タブに出す潮汐地点。"ST:<code>" / "AR:<code>" 形式の配列。';

-- 形式チェック。実在する地点かどうかは 2 テーブルにまたがるため CHECK では
-- 書けない（副問い合わせが使えない）。ここは形式だけを保証し、存在しない
-- コードは画面側で読み飛ばす。
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_favorite_tide_points_format;

-- CHECK では副問い合わせが使えないため、連結した 1 本の文字列で検証する
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_favorite_tide_points_format CHECK (
    array_to_string(favorite_tide_points, ',')
      ~ '^$|^(ST|AR):[A-Z0-9-]{1,32}(,(ST|AR):[A-Z0-9-]{1,32})*$'
  );

COMMIT;
