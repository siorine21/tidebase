-- ============================================================
-- 「ニベ・109cm」で記録されていた釣果 1 件をオオニベに付け替える（D-179）
--
-- 2026-10-17 04:00・天竜川河口サーフ（浜松側）・109cm。
-- ニベは大きくても 60cm ほどで、この大きさはオオニベ。052 でオオニベを
-- 足すまで選択肢が無く、近い名前のニベで記録するしかなかった。
-- **本人に「オオニベなので付け替えて」と確かめてから直した。**
--
-- 対象は id で 1 件に絞り、「いまニベであること」も条件に入れる。
-- 別の DB（テスト）ではこの行が無いので、何も起きない。
-- ============================================================

BEGIN;

UPDATE public.fishing_records
SET fish_species_id = (SELECT id FROM public.fish_species
                       WHERE user_id IS NULL AND name = 'オオニベ')
WHERE id = '4c4cbf69-8da1-421f-bfca-f310970483b9'
  AND fish_species_id = (SELECT id FROM public.fish_species
                         WHERE user_id IS NULL AND name = 'ニベ');

COMMIT;
