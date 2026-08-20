/**
 * 潮汐データ API（Supabase Edge Function・認証不要 = D-009）
 *
 *   GET /functions/v1/tide?station=TK&date=2026-07-17
 *
 * 旧 GET /api/v1/tide（FastAPI）の移植（D-021）。
 * 公的データのみを返すため verify_jwt は無効（supabase/config.toml）。
 */
import {
  findDay,
  JMA_TIDE_URL_TEMPLATES,
  moonAge,
  sourceUrl,
  tideType,
} from "./parser.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// 観測点×年ごとの年間テキストキャッシュ（インスタンス生存中のみ）
const cache = new Map<string, { text: string; fetchedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 推算値は静的だが念のため 24h

/* 失敗したときだけ 1 行残す（D-125）。
   ここは以前まったく無言で、502 を返しても見に行く先が無かった。
   **入れるのは経路と理由だけ。** 利用者を特定できるものは入れない。 */
function logFail(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ fn: "tide", event, ...detail }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchYearText(station: string, year: number): Promise<string> {
  const key = `${station}-${year}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  let lastStatus = 0;
  for (const template of JMA_TIDE_URL_TEMPLATES) {
    const url = template
      .replace("{year}", String(year))
      .replace("{station}", station);
    const response = await fetch(url);
    if (response.ok) {
      const text = await response.text();
      cache.set(key, { text, fetchedAt: Date.now() });
      return text;
    }
    lastStatus = response.status;
    if (response.status !== 404) break; // 404 のみ旧 URL へフォールバック
  }
  throw Object.assign(new Error(`JMA fetch failed: ${lastStatus}`), {
    status: lastStatus,
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return json(405, { error: "GET のみ対応しています" });
  }

  const params = new URL(request.url).searchParams;
  const station = params.get("station") ?? "";
  const date = params.get("date") ?? "";

  if (!/^[A-Z0-9]{2}$/.test(station)) {
    return json(422, { error: "station は 2 文字の地点記号で指定してください（例: TK）" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(422, { error: "date は YYYY-MM-DD 形式で指定してください" });
  }

  const year = Number(date.slice(0, 4));
  let yearText: string;
  try {
    yearText = await fetchYearText(station, year);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      logFail("source_not_found", { station, year });
      return json(404, { error: `観測地点 ${station} の ${year} 年データがありません` });
    }
    logFail("source_fetch_failed", { station, year, status: status ?? null });
    return json(502, { error: "潮汐データの取得に失敗しました" });
  }

  const day = findDay(yearText, date);
  if (day === null) {
    /* 取得はできたのに読めない＝**気象庁側の書式が変わった可能性**。
       いちばん気づきにくい壊れ方なので、必ず残す */
    logFail("parse_miss", { station, date, bytes: yearText.length });
    return json(404, { error: `${date} の潮汐データが見つかりません` });
  }

  return json(200, {
    station: day.station,
    date: day.date,
    tide_type: tideType(date),
    moon_age: moonAge(date),
    hourly_levels_cm: day.hourly_levels_cm,
    high_tides: day.high_tides,
    low_tides: day.low_tides,
    source: sourceUrl(station, year),
  });
});
