-- ============================================================
-- 魚種マスタに 4 種追加し、「イカ」をアオリイカとコウイカに分ける
--
-- 静岡県西部（遠州灘・浜名湖・河川）でルアーの対象になる魚のうち、
-- 抜けていたものを足す。並び順は 006 の考え方
-- （近縁種・釣り方が近いものを隣接させる）を引き継ぎ、
-- 既存の行は動かさずに間の番号を使う。
--
--   ハゼ         汽水 30   浜名湖・河口・河川。ハゼクランク。
--                          クロダイ(10)・キビレ(20) と同じく主戦場が汽水域
--   ソウダガツオ 海水 45   サワラ(40) の隣。どちらもサバ科の回遊魚
--   シイラ       海水 46   表層の大型回遊。狙う場所と時期がソウダガツオに近い
--   ニベ         海水 85   ヒラメ(70)・マゴチ(80) の後。遠州灘サーフの砂地物で、
--                          同じタックルで釣れる
--
-- 「イカ」を分ける件:
--   舞阪・新居・浜名湖はエギングの好フィールドで、アオリイカとコウイカは
--   時期も釣り方も別物。ひと括りだと記録として使えない。
--
--   **参照している釣果が 0 件であることを確認してから分けた。**
--   fishing_records.fish_species_id からの参照も、fish_name_local の
--   自由入力（'%イカ%'）も 0 件。1 件でもあれば、どちらに寄せるかを
--   決めずに消すことになるので、先に数えている。
--   行は消さずに名前を変える（id が変わらないので、万一どこかが
--   id を覚えていても壊れない）。
-- ============================================================

BEGIN;

INSERT INTO public.fish_species (user_id, name, category, sort_order) VALUES
  (NULL, 'ハゼ',         '汽水',  30),
  (NULL, 'ソウダガツオ', '海水',  45),
  (NULL, 'シイラ',       '海水',  46),
  (NULL, 'ニベ',         '海水',  85)
ON CONFLICT (user_id, name) DO NOTHING;

-- 「イカ」→「アオリイカ」に改名し、「コウイカ」を隣に足す
UPDATE public.fish_species
SET name = 'アオリイカ'
WHERE user_id IS NULL AND name = 'イカ'
  AND NOT EXISTS (SELECT 1 FROM public.fish_species
                  WHERE user_id IS NULL AND name = 'アオリイカ');

INSERT INTO public.fish_species (user_id, name, category, sort_order) VALUES
  (NULL, 'コウイカ', '海水', 132)
ON CONFLICT (user_id, name) DO NOTHING;

COMMIT;
