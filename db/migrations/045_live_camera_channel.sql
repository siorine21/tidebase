-- ============================================================
-- ライブカメラを「動画」ではなく「チャンネル」で指す
--
-- 043 で動画 ID を持たせ、044 でアーカイブから生配信へ差し替えた。
-- **だが差し替えが要ったこと自体が、この持ち方の弱点だった。**
--
-- YouTube のライブは、配信する側が配信を切り直すたびに動画 ID が変わる。
-- そのとき TIDEBASE 側は何も壊れない。CHECK も通り iframe も出て、
-- 枠の中では映像が普通に流れる。**古い録画が「いまの海」の顔をして出続ける。**
-- 海を見てから行き先を決めるための機能なので、黙って間違えるいちばん悪い形になる。
--
-- チャンネル ID を持てば `embed/live_stream?channel=` で
-- 「いま生放送しているもの」が出るので、切り直されても追従する。
-- D-143 の時点で直し方は分かっていたが、youtube.com が遮断されていて
-- チャンネル ID を確かめられなかった。本人が URL を出してくれたので入れる。
--
-- **どちらか一方しか持たせない。** 両方あると「どちらが正か」が分からなくなり、
-- 片方だけ直して取り残す（043 で spots の列を消したのと同じ理由）。
-- チャンネルを持つカメラは動画 ID を持たない。
-- ============================================================

BEGIN;

ALTER TABLE public.live_cameras
  ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT;

-- チャンネル ID は UC + 22 桁。ここが iframe の src に入るので DB でも縛る
-- （画面側の parseYouTubeChannelId と合わせて境界を 2 枚にする・D-143）
ALTER TABLE public.live_cameras
  DROP CONSTRAINT IF EXISTS live_cameras_youtube_channel_id_check;
ALTER TABLE public.live_cameras
  ADD CONSTRAINT live_cameras_youtube_channel_id_check
  CHECK (youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$');

-- 動画 ID は「チャンネルが分からないカメラ」のための道として残す。
-- 両方は持てない
ALTER TABLE public.live_cameras ALTER COLUMN youtube_id DROP NOT NULL;
ALTER TABLE public.live_cameras
  DROP CONSTRAINT IF EXISTS live_cameras_one_source;
ALTER TABLE public.live_cameras
  ADD CONSTRAINT live_cameras_one_source
  CHECK (num_nonnulls(youtube_id, youtube_channel_id) = 1);

-- 同笠海岸をチャンネルに移す。**動画 ID は消す**（1 つだけが正）
UPDATE public.live_cameras
SET youtube_channel_id = 'UCklttRvu7xLyAIHfn1Rqreg',
    youtube_id = NULL
WHERE code = 'ENSHU-DOUGASA';

COMMIT;
