-- ============================================================
-- 表浜名湖のライブカメラを入れる
--
-- 043 の時点で本人が「もう一つ置くとしたら浜名湖」と言っていた枠。
-- 探した結果、**表浜名湖（今切口の内側）を映しているもの**は
-- 舞阪漁港の「魚あら」の塔から出ている 24 時間配信が唯一だった。
-- 浜名湖・舞阪漁港・浜名大橋・弁天島の方向が入る。配信は ZAZA マガジン
-- （https://www.youtube.com/@zaza6075 ／ 動画 lLG9L053onI）。
--
-- 候補として湖西市の「新居弁天海湖館」の津波監視カメラもあった。位置は
-- 今切口のすぐ西で申し分ないが、**静止画の独自配信**なので埋め込めない。
-- 浜名湖ガーデンパーク（村櫛町）のカメラは湖の中ほどで、表浜名湖ではない。
--
-- **動画 ID で入れる。** チャンネル ID（UC…）のほうが良いのは 045 のとおりだが、
-- この環境からは youtube.com が 403 で見えず、@ハンドルから UC を引けない。
-- 分かった時点で 045 と同じ形で差し替える（そのために youtube_id は
-- 「チャンネルが分からないカメラのための道」として残してある）。
--
-- **座標は入れない。** 座標があると画面がその場所の沖の波を取りに行くが、
-- 湖の中に沖の波高を出しても読む意味が無く、海の格子は粗いので
-- 外洋の値に引っぱられて「1.2m」のような数字が出かねない。
-- 意味を持たない場所では取りに行かない（D-142）。lat/lng が空なら
-- 画面は波を出さない。
-- ============================================================

BEGIN;

INSERT INTO public.live_cameras
  (code, name, youtube_id, youtube_channel_id, water_body, lat, lng, note, sort_order)
VALUES
  ('HAMANA-MAISAKA', '表浜名湖（舞阪漁港）', 'lLG9L053onI', NULL, '浜名湖',
   NULL, NULL,
   '舞阪漁港の塔から浜名大橋・弁天島の方向。今切口の内側の濁りと水の動きを見る', 20)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    youtube_id = EXCLUDED.youtube_id,
    youtube_channel_id = EXCLUDED.youtube_channel_id,
    water_body = EXCLUDED.water_body,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    note = EXCLUDED.note,
    sort_order = EXCLUDED.sort_order;

COMMIT;
