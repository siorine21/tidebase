-- ============================================================
-- スポット削除ガードが「退会（アカウント削除）」を妨げる問題の修正
--
-- 症状: 釣果が紐付いたスポットを持つユーザーを削除すると、
--       auth.users → profiles → spots の CASCADE 途中で
--       guard_spot_delete が発火し、削除全体が失敗する。
--       = ユーザーが自分の個人データを消せない（GDPR 対応の妨げ）。
--
-- 対処: 所有ユーザー自体が削除される場合はガードを適用しない。
--       CASCADE は親（profiles）から順に処理されるため、
--       spots のトリガー時点で profiles 行は既に消えている。
--       通常のスポット削除（確定仕様書 17.2 章）のガードはそのまま維持する。
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_spot_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  linked_count INTEGER;
BEGIN
  -- 退会などで所有ユーザーごと削除される場合はガードしない
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;

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

COMMIT;
