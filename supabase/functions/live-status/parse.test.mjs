/**
 * 「いま生放送しているか」を読む処理（D-156）のテスト。
 *   node --test supabase/functions/live-status/parse.test.mjs
 *
 * **ここは古い録画を「いまの海」として出さないための関所。**
 * 生放送していないチャンネルの `/live` は、**直近の配信のアーカイブ**へ
 * 落ちることがある。そのまま埋め込むと、何も壊れないまま
 * 古い録画が「いまの海」の顔をして出続ける（D-145 でいちばん嫌った形）。
 *
 * 押さえるのは 3 つ。
 *   - **生放送だとはっきり書いてあるときだけ**動画 ID を返す
 *   - 読めなかったことを「配信していない」と言わない（null と false は別物）
 *   - 取りに行く URL は形を確かめてから組み立てる（SSRF の入口）
 *
 * 作り物の HTML は、**実際に返ってきたものの形に合わせてある**（実測・D-156）。
 * YouTube は `/live` に JS で描く殻を返すので、title も canonical も使えない。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { channelLiveUrl, readLiveStatus, YOUTUBE_CHANNEL_ID }
  from "./_build/parse.js";

const CH = "UCklttRvu7xLyAIHfn1Rqreg";
const VID = "maTr7UQfHkE";

/** 生放送中のページ。実際の並びに寄せてある */
const livePage = ({ id = VID, title = "海岸監視カメラ　同笠海岸", viewers = "1 人が視聴中",
                    overlay = true, isLive = true } = {}) =>
  `<!DOCTYPE html><html><head><title> - YouTube</title>`
  + `<link rel="canonical" href="undefined"></head><body>`
  + `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>`
  + `<script>var ytInitialData = {"currentVideoEndpoint":{"clickTrackingParams":"XX",`
  + `"watchEndpoint":{"videoId":"${id}"}},`
  + (overlay ? `"playerOverlayVideoDetailsRenderer":{"title":{"simpleText":"${title}"}},` : "")
  + `"viewCount":{"runs":[{"text":"${viewers}"}]}`
  + (isLive ? `,"isLive":true` : "")
  + `};</script></body></html>`;

/* ---- 取りに行く URL は、形を確かめてから組み立てる ---- */
test("チャンネル ID の形が合えば URL になる", () => {
  assert.equal(channelLiveUrl(CH), `https://www.youtube.com/channel/${CH}/live`);
});

test("**形が違えば取りに行かない**（ここが SSRF の入口）", () => {
  for (const bad of [
    "", null, undefined, "UC", "javascript:alert(1)",
    `${CH}/../../evil`, `${CH}?x=1`, "../../etc/passwd",
    "UCklttRvu7xLyAIHfn1Rqre", "UCklttRvu7xLyAIHfn1Rqregg",
    "https://evil.example.com/",
  ]) {
    assert.equal(channelLiveUrl(bad), null, `${JSON.stringify(bad)} が通った`);
  }
});

test("通るチャンネル ID は URL に危ない字を含まない", () => {
  assert.ok(YOUTUBE_CHANNEL_ID.test(CH));
  assert.equal(encodeURIComponent(CH), CH);
});

/* ---- 生放送している ---- */
test("生放送中なら動画 ID と題名が返る", () => {
  const got = readLiveStatus(livePage());
  assert.equal(got.live, true);
  assert.equal(got.videoId, VID);
  assert.equal(got.title, "海岸監視カメラ　同笠海岸");
  assert.equal(got.viewers, "1 人が視聴中");
});

test("overlay だけでも生放送とみなす", () => {
  assert.equal(readLiveStatus(livePage({ isLive: false })).live, true);
});

test("isLive だけでも生放送とみなす", () => {
  assert.equal(readLiveStatus(livePage({ overlay: false })).live, true);
});

test("題名の \\u エスケープを戻す", () => {
  const html = livePage({ title: "\\u6d77\\u5cb8" });
  assert.equal(readLiveStatus(html).title, "海岸");
});

/* ---- 生放送していない ---- */
test("**アーカイブへ落ちても生放送とは言わないし、動画 ID も返さない**", () => {
  // 動画には解決したが、生放送の印がどこにも無い
  const got = readLiveStatus(livePage({ overlay: false, isLive: false }));
  assert.equal(got.live, false);
  assert.equal(got.videoId, null, "アーカイブの ID を渡してはいけない");
});

test("動画に解決していなければ、配信していない", () => {
  const html = `<script>var ytInitialData = {"contents":{}};</script>`;
  const got = readLiveStatus(html);
  assert.equal(got.live, false);
  assert.equal(got.videoId, null);
});

/* ---- 読めなかった ----
   **null と false は別物。** 読めなかったことを「配信していない」と言うと、
   向こうは流しているのに、こちらの都合で止まっているように見せてしまう */
test("ytInitialData が無ければ分からない（null）", () => {
  assert.equal(readLiveStatus("<html><body>なにもない</body></html>").live, null);
  assert.equal(readLiveStatus("").live, null);
  assert.equal(readLiveStatus(null).live, null);
});

test("生放送の印はあるのに動画 ID が読めなければ、分からない（null）", () => {
  // 形が変わって videoId だけ取れなくなった場合。**false と言い切らない**
  const html = `<script>var ytInitialData = {"playerOverlayVideoDetailsRenderer":{},`
    + `"isLive":true};</script>`;
  assert.equal(readLiveStatus(html).live, null);
});

/* ---- 実際に返ってきたものでは動かない手がかり（D-156 の実測） ---- */
test("title と canonical は当てにしない（殻が返るため）", () => {
  const got = readLiveStatus(livePage());
  // 殻の title は「 - YouTube」、canonical は href="undefined"。それでも読めている
  assert.equal(got.live, true);
  assert.equal(got.videoId, VID);
});
