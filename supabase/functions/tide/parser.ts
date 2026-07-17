/**
 * 気象庁 潮位表（推算値）テキストのパーサーと潮回り判定。
 * 旧 backend/app/services/tide.py の TypeScript 移植（D-021）。
 *
 * 固定長フォーマット（1 行 = 1 日、気象庁公開仕様）:
 *   1-72    毎時潮位（0〜23時、3桁 cm × 24）
 *   73-74   年（西暦下2桁） / 75-76 月 / 77-78 日 / 79-80 地点記号
 *   81-108  満潮 4 回分（時刻 hhmm 4桁 + 潮位 3桁 = 7桁 × 4）
 *   109-136 干潮 4 回分（同上）
 *   欠測・該当なしは時刻 9999 / 潮位 999。
 *
 * 月齢・潮回りは DB 実装（004_schema_v1.4 の moon_age / tide_type）と
 * 同一ロジック・同一丸め（四捨五入）に揃えること。
 */

export interface TideEvent {
  time: string | null; // "HH:MM"
  level_cm: number | null;
}

export interface TideDay {
  station: string;
  date: string; // "YYYY-MM-DD"
  hourly_levels_cm: (number | null)[];
  high_tides: TideEvent[];
  low_tides: TideEvent[];
}

// 気象庁サイトは URL 再編で /gmd/ が外れた経緯があるため、新旧の順に試す
export const JMA_TIDE_URL_TEMPLATES = [
  "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{station}.txt",
  "https://www.data.jma.go.jp/gmd/kaiyou/data/db/tide/suisan/txt/{year}/{station}.txt",
] as const;

export function sourceUrl(station: string, year: number): string {
  return JMA_TIDE_URL_TEMPLATES[0]
    .replace("{year}", String(year))
    .replace("{station}", station);
}

const LINE_LENGTH = 136;

// 朔（新月）基準: 2000-01-06 18:14 UTC / 朔望月の平均周期
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MONTH = 29.530588853;

/** 四捨五入（Math.round は正の値で half-up = SQL の ROUND と一致） */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** JST 正午時点の月齢。isoDate は "YYYY-MM-DD" */
export function moonAge(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const noonJstMs = Date.UTC(y, m - 1, d, 3, 0); // 12:00 JST = 03:00 UTC
  const elapsedDays = (noonJstMs - NEW_MOON_EPOCH_MS) / 86_400_000;
  return round1(((elapsedDays % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH);
}

const SPRING = new Set([0, 1, 2, 14, 15, 16, 17, 29]);
const MIDDLE = new Set([3, 4, 5, 6, 12, 13, 18, 19, 20, 21, 27, 28]);
const NEAP = new Set([7, 8, 9, 22, 23, 24]);
const LONG = new Set([10, 25]);

export function tideType(isoDate: string): string {
  const idx = Math.round(moonAge(isoDate)) % 30;
  if (SPRING.has(idx)) return "大潮";
  if (MIDDLE.has(idx)) return "中潮";
  if (NEAP.has(idx)) return "小潮";
  if (LONG.has(idx)) return "長潮";
  return "若潮"; // 11, 26
}

function parseLevel(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "999") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

function parseEvent(chunk: string): TideEvent | null {
  const timePart = chunk.slice(0, 4);
  const levelPart = chunk.slice(4, 7);
  const trimmedTime = timePart.trim();
  if (trimmedTime === "" || trimmedTime === "9999") return null;
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  if (
    !Number.isInteger(hour) || !Number.isInteger(minute) ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) {
    return null;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return { time: `${hh}:${mm}`, level_cm: parseLevel(levelPart) };
}

/** 潮位表 1 行（= 1 日分）をパースする。不正行は null */
export function parseLine(rawLine: string): TideDay | null {
  const line = rawLine.replace(/[\r\n]+$/, "").padEnd(LINE_LENGTH);

  const year = Number(line.slice(72, 74).trim());
  const month = Number(line.slice(74, 76).trim());
  const day = Number(line.slice(76, 78).trim());
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    line.slice(72, 78).trim() === "" ||
    month < 1 || month > 12 || day < 1 || day > 31
  ) {
    return null;
  }

  const hourly: (number | null)[] = [];
  for (let i = 0; i < 24; i++) {
    hourly.push(parseLevel(line.slice(i * 3, (i + 1) * 3)));
  }

  const highs: TideEvent[] = [];
  const lows: TideEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const high = parseEvent(line.slice(80 + i * 7, 87 + i * 7));
    if (high) highs.push(high);
    const low = parseEvent(line.slice(108 + i * 7, 115 + i * 7));
    if (low) lows.push(low);
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    station: line.slice(78, 80).trim(),
    date: `${2000 + year}-${mm}-${dd}`,
    hourly_levels_cm: hourly,
    high_tides: highs,
    low_tides: lows,
  };
}

/** 年間テキストから対象日の行を探す */
export function findDay(
  yearText: string,
  isoDate: string,
): TideDay | null {
  for (const line of yearText.split("\n")) {
    const parsed = parseLine(line);
    if (parsed && parsed.date === isoDate) return parsed;
  }
  return null;
}
