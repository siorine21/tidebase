/**
 * 地図アプリの短縮 URL を座標に開く（Supabase Edge Function・要ログイン）
 *
 *   POST /functions/v1/resolve-map-link
 *        { url: "https://maps.app.goo.gl/xxxx" }
 *        → { lat, lng, name, approximate }
 *          approximate=true は「住所から求めたおおよその位置」
 *
 * なぜ Edge Function か:
 *   短縮 URL には座標が入っていない。リダイレクトを追った先の長い URL に
 *   初めて「!3d緯度!4d経度」が現れる。ところがブラウザからは追えない。
 *   goo.gl は CORS を許していないので、fetch は不透明な応答になり、
 *   飛んだ先の URL（response.url）が空になる。no-cors でも同じ。
 *   つまり**サーバー側で 1 回踏まないと解けない**。
 *
 *   これまでは「一度ブラウザで開いて、長い URL を貼り直してください」と
 *   案内していたが、スマホで LINE から届いたリンクを共有するときに
 *   毎回それをやるのは現実的ではない。
 *
 * 安全のために:
 *   - **行き先は短縮 URL の提供元だけに限る**。任意の URL を取りに行けるようにすると、
 *     この関数がそのまま踏み台（SSRF）になる。ホストを固定の候補で照合し、
 *     少しでも外れたら取りに行かない。
 *   - 本文はそのまま返さない。座標だけを取り出して返す。
 *   - **ログイン済みの人しか叩けない**。verify_jwt = true だけでは足りず、
 *     publishable（anon）キーだけで通ってしまうのを実際に確かめたので、
 *     関数の中でも利用者のトークンかどうかを見ている（isSignedIn）。
 */

import { coordsFromUrl, placeLabel } from "./parse.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

/**
 * 取りに行ってよいホスト。**完全一致のみ**。
 * `endsWith(".goo.gl")` のような書き方にすると `evil-goo.gl` が通ってしまう。
 */
const ALLOWED_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "g.co",
  "maps.google.com",
  "www.google.com",
]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

/**
 * ログイン済みの利用者からの呼び出しかを確かめる。
 *
 * verify_jwt = true だけでは足りない。**publishable（anon）キーそのものが通ってしまう**。
 * このキーは画面に埋め込んで配る前提の公開キーで、リポジトリも公開しているので、
 * 誰でも拾える。この関数は外へ取りに行くので、開けっぱなしにすると
 * 短縮 URL の展開屋として実行回数を使い潰される。
 * そこで**本物の利用者のトークンかどうかを Auth に聞く**。
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

/** 追うリダイレクトの上限。無限に飛ばされ続けないように。 */
const MAX_HOPS = 5;
const FETCH_TIMEOUT_MS = 8000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** 住所から座標を引く（国土地理院）。当たらなければ null。 */
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  let data: unknown;
  try {
    const response = await fetch(
      "https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + encodeURIComponent(address),
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    data = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !data.length) return null;
  // GeoJSON なので [経度, 緯度] の順
  const [lng, lat] = (data[0] as { geometry?: { coordinates?: number[] } })
    ?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Number(lat) < 20 || Number(lat) > 46 || Number(lng) < 122 || Number(lng) > 154) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

function isAllowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // http/https 以外（file: や data: など）は最初から相手にしない
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;
  return url;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { error: "POST してください。" });
  }
  if (!await isSignedIn(request)) {
    return json(401, { error: "ログインしてください。" });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "リクエストを読めませんでした。" });
  }

  const start = isAllowed(String(body?.url ?? "").trim());
  if (!start) {
    return json(400, { error: "この URL は開けません。地図アプリのリンクを貼り付けてください。" });
  }

  // リダイレクトを 1 つずつ追う。redirect: "follow" に任せず手で追うのは、
  // **途中の行き先も毎回ホストを照合する**ため。
  // 追従を任せると、1 回目だけ確認して残りは素通しになる。
  let current = start;
  let finalUrl = start.href;
  let html = "";

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          // 素の Deno の UA だと同意ページに飛ばされやすい。日本語で頼む
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "ja,en;q=0.8",
        },
      });
    } catch {
      return json(502, { error: "リンクを開けませんでした。時間をおいて試してください。" });
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = isAllowed(new URL(location, current.href).href);
      if (!next) {
        // 想定外の行き先。ここで止める（追いかけない）
        return json(422, { error: "座標を読み取れませんでした。長い URL を貼り付けてください。" });
      }
      current = next;
      finalUrl = next.href;
      continue;
    }

    // これ以上飛ばない。本文にも座標が入っていることがあるので読んでおく
    finalUrl = response.url || current.href;
    html = await response.text().catch(() => "");
    break;
  }

  // 1. 飛んだ先の URL に座標が入っていれば、それがいちばん正確。
  //    地図を長押しして落としたピンや「この場所を共有」はここで解ける
  const point = coordsFromUrl(finalUrl) ?? coordsFromUrl(html);
  const label = placeLabel(finalUrl);
  if (point) {
    return json(200, { lat: point.lat, lng: point.lng, name: label.name, approximate: false });
  }

  // 2. 店舗や施設を共有したリンクには座標が入っておらず、代わりに
  //    「〒421-0212 静岡県焼津市利右衛門１１５ アルクスポンド 焼津」のように
  //    **住所が入っている**。座標は地図の JavaScript が後から入れるので、
  //    本文を取っただけでは出てこない（実際に確かめた）。
  //    そこで住所を国土地理院で引く。大字までしか当たらないので、
  //    **おおよその位置であることを呼び出し側に伝える**。
  if (label.address) {
    const found = await geocodeAddress(label.address);
    if (found) {
      return json(200, {
        lat: found.lat, lng: found.lng, name: label.name,
        approximate: true, address: label.address,
      });
    }
  }

  return json(422, { error: "この URL からは場所を読み取れませんでした。" });
});
