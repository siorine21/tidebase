-- ============================================================
-- スポット座標のガード
--
-- 背景:
--   釣果入力の旧フォームは緯度・経度を数値入力させていたため、空欄のまま
--   登録すると Number("") = 0 で (0, 0) が保存されてしまっていた。
--   (0, 0) は大西洋ギニア湾なので、Open-Meteo が返す日の出・日没・天気が
--   まるで別の場所の値になる（日の出 15:02 / 日没 03:09 など）。
--   入力は地図タップ方式に変えたが、どの経路からも入り込まないよう
--   DB 側でも弾いておく。
--
-- 日本国内の範囲（南鳥島・沖ノ鳥島・与那国島を含む）:
--   緯度 20〜46 / 経度 122〜154
--
-- NOT VALID にしているのは、既存の (0, 0) 行を残したまま新規の書き込みだけを
-- 検証したいため。利用者が地図から位置を設定し直したら
--   ALTER TABLE public.spots VALIDATE CONSTRAINT spots_coordinates_in_japan;
-- で全行検証に切り替えられる。
-- ============================================================

BEGIN;

ALTER TABLE public.spots
  DROP CONSTRAINT IF EXISTS spots_coordinates_in_japan;

ALTER TABLE public.spots
  ADD CONSTRAINT spots_coordinates_in_japan CHECK (
    latitude  BETWEEN 20 AND 46
    AND longitude BETWEEN 122 AND 154
  ) NOT VALID;

COMMENT ON CONSTRAINT spots_coordinates_in_japan ON public.spots IS
  '日本国内の座標のみ許可する。(0,0) が入ると天気・日の出日没が別の場所の値になるため。';

COMMIT;
