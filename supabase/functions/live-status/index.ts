/**
 * ライブ映像が「いま配信中か」を返す（Supabase Edge Function・要ログイン）
 *
 *   GET /functions/v1/live-status?channel=UCxxxxxxxxxxxxxxxxxxxxxx
 *        → { live: true,  video_id: "xxxxxxxxxxx", title: "...", viewers: "1 人が視聴中" }
 *        → { live: false, video_id: null }
 *        → { live: null,  video_id: null, reason: "unreachable" }   ← 分からなかった
 *
 * なぜ Edge Function か:
 *   埋め込みの枠は別オリジンなので、**ブラウザからは中身を一切読めない**。
 *   止まっているのか、埋め込みを拒否されているのか、そもそも枠が出ていないのかが
 *   区別できず、黒い枠を見せられた側は「壊れている」としか言えない。
 *   サーバー側から 1 回見に行けば、開く前に「いま止まっています」と言える。
 *   YouTube Data API の鍵は要らない（公開ページを読むだけ・D-022 を守る）。
 *
 * 安全のために（resolve-map-link と同じ考え方・D-072）:
 *   - **行き先は youtube.com のチャンネルページだけ**。channel は UC+22 桁の形を
 *     通ったものしか受け取らず、URL はこちらで組み立てる。任意の URL は取りに行かない。
 *   - 本文はそのまま返さない。live / video_id / 題名 / 視聴者数だけを返す。
 *   - **ログイン済みの人しか叩けない**。verify_jwt = true だけでは足りず、
 *     publishable（anon）キーだけで通ってしまうので、中でも確かめる（isSignedIn）。
 *   - 同じチャンネルは 60 秒だけ覚える。ホームを開くたびに YouTube を叩かない。
 */

import { channelLiveUrl, readLiveStatus, YOUTUBE_CHANNEL_ID } from "./parse.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 1000;

/** チャンネルごとの直近の結果（インスタンスが生きている間だけ）。 */
const cache = new Map<string, { at: number; body: Record<string, unknown> }>();

/**
 * ログイン済みの利用者からの呼び出しかを確かめる。
 * verify_jwt = true だけでは足りない（**publishable キーそのものが通る**）。
 * 公開リポジトリなので、そのキーは誰でも拾える。
 */
async function isSignedIn(request: Request): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token === ANON_KEY) return false;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* 失敗したときだけ 1 行残す（D-125）。チャンネル ID は公開情報なので残してよい。 */
function logFail(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ fn: "live-status", event, ...detail }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return json(405, { error: "GET してください。" });
  }
  if (!await isSignedIn(request)) {
    return json(401, { error: "ログインしてください。" });
  }

  const channel = new URL(request.url).searchParams.get("channel")?.trim() ?? "";
  if (!YOUTUBE_CHANNEL_ID.test(channel)) {
    return json(400, { error: "チャンネル ID の形が違います。" });
  }

  const known = cache.get(channel);
  if (known && Date.now() - known.at < CACHE_TTL_MS) {
    return json(200, { ...known.body, cached: true });
  }

  const url = channelLiveUrl(channel);
  if (!url) return json(400, { error: "チャンネル ID の形が違います。" });

  let html = "";
  try {
    const response = await fetch(url, {
      // 素の fetch だと同意画面や簡易版を返されることがあるので、ふつうの UA を名乗る
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
          + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept-Language": "ja,en;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logFail("fetch-not-ok", { channel, status: response.status });
      return json(200, { live: null, video_id: null,
        reason: `status-${response.status}`, checked_at: new Date().toISOString() });
    }
    html = await response.text();
  } catch (error) {
    logFail("fetch-failed", { channel, message: String((error as Error)?.message ?? error) });
    return json(200, { live: null, video_id: null,
      reason: "unreachable", checked_at: new Date().toISOString() });
  }

  const status = readLiveStatus(html);
  const body = {
    live: status.live,
    video_id: status.videoId,
    title: status.title,
    viewers: status.viewers,
    checked_at: new Date().toISOString(),
  };
  /* **読めなかったときは覚えない**（D-140 と同じ）。覚えると、
     たまたま読めなかった 1 回が 60 秒ぶん「分からない」を配り続ける */
  if (status.live !== null) cache.set(channel, { at: Date.now(), body });
  return json(200, body);
});
