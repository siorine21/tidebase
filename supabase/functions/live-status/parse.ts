/**
 * `/channel/<id>/live` の HTML から「いま生放送しているか」と、その動画 ID を読む（D-156）。
 *
 * **画面からは分からないことを、事実にするための部品。**
 * 埋め込みの枠は別オリジンなのでブラウザからは中身を一切読めない。
 * 止まっているのか、埋め込みが拒否されているのか、そもそも枠が出ていないのかが
 * 区別できず、1 週間ずっと「見えない」としか言えなかった。
 *
 * **どこを読むか（実測で決めた）**
 * YouTube は `/live` に対して JS で描く殻を返す。だから素直な手がかりは使えない:
 *   - `<title>` は「 - YouTube」で空
 *   - `<link rel="canonical">` は **href="undefined"** という文字列
 *   - `ytInitialPlayerResponse` は `playabilityStatus: LOGIN_REQUIRED`
 *     （データセンターの IP から Cookie 無しで叩いているため）
 * 一方 **`ytInitialData` のほうは読める**。生放送中なら
 *   - `currentVideoEndpoint` に**いま流れている動画の ID**
 *   - `playerOverlayVideoDetailsRenderer` に配信の題名
 *   - `"isLive":true` と「◯人が視聴中」
 * が入っている。ここだけを見る。
 *
 * ここは**文字列を読むだけ**。通信は index.ts が行う。
 */

/** チャンネル ID の形。UC + 22 桁。**ここが URL に入るので必ず通す**（D-143 と同じ） */
export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** 動画 ID の形。11 桁。 */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export type LiveStatus = {
  /** true = 生放送中 / false = していない / null = 読めなかった */
  live: boolean | null;
  /** 生放送中のときだけ入る。**していないときは絶対に入れない** */
  videoId: string | null;
  /** 配信の題名（分かれば） */
  title: string | null;
  /** 「1 人が視聴中」など、そのままの文字列（分かれば） */
  viewers: string | null;
};

const UNKNOWN: LiveStatus = { live: null, videoId: null, title: null, viewers: null };

/**
 * 取りに行く URL。**組み立てるのはここだけ**で、入力は形を確かめてから入れる。
 * ここを緩めると、この関数がそのまま踏み台（SSRF）になる。
 */
export function channelLiveUrl(channelId: string): string | null {
  return YOUTUBE_CHANNEL_ID.test(String(channelId ?? ""))
    ? `https://www.youtube.com/channel/${channelId}/live`
    : null;
}

/** JSON の中の `\uXXXX` と `\"` を戻す。題名は日本語なのでここを通さないと読めない */
function unescapeJson(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * 生放送しているかを読む。
 *
 * **「動画 ID があった＝生放送中」ではない。** 生放送していないチャンネルの
 * `/live` は、**直近の配信のアーカイブ**へ落ちることがある。そのまま埋め込むと
 * 古い録画が「いまの海」の顔をして出る（D-145 でいちばん嫌った形）。
 * だから**生放送だとはっきり書いてあるときだけ**動画 ID を返す。
 * 返さなければ、使う側が間違えようがない。
 */
export function readLiveStatus(html: string): LiveStatus {
  const text = String(html ?? "");
  const start = text.indexOf("ytInitialData");
  if (start < 0) return UNKNOWN;
  const data = text.slice(start);

  // いま `/live` が解決した動画。生放送していなければ、そもそも入らない
  const videoId = (data.match(
    /"currentVideoEndpoint"[^]{0,400}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/,
  ) ?? [])[1] ?? null;

  /* 生放送であることの印。**2 つとも見る。**
     overlay は生放送のプレーヤーにだけ出る枠で、isLive は視聴者数のところに付く */
  const hasOverlay = data.includes("playerOverlayVideoDetailsRenderer");
  const saysLive = /"isLive"\s*:\s*true/.test(data);

  if (!videoId) {
    // 動画に解決していない＝いま流れているものが無い。**読めなかったのとは別**
    return hasOverlay || saysLive ? UNKNOWN : { ...UNKNOWN, live: false };
  }
  if (!(hasOverlay || saysLive)) {
    // 動画には解決したが生放送ではない（アーカイブ）。**動画 ID は返さない**
    return { live: false, videoId: null, title: null, viewers: null };
  }

  const title = (data.match(
    /"playerOverlayVideoDetailsRenderer"[^]{0,300}?"simpleText"\s*:\s*"([^"]{0,120})"/,
  ) ?? [])[1] ?? null;
  const viewers = (data.match(
    /"viewCount"\s*:\s*\{"runs":\[\{"text":"([^"]{0,30})"/,
  ) ?? [])[1] ?? null;

  return {
    live: true,
    videoId,
    title: title ? unescapeJson(title) : null,
    viewers: viewers ? unescapeJson(viewers) : null,
  };
}
