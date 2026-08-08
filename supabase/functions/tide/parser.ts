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

/* ---------------- 月齢・潮回り（D-062・frontend/assets/app.js と同じ計算） ----------------
   潮回りは「朔（新月）からの日数」で決まる。以前は朔望月の平均（29.530588853 日）を
   2000 年の朔から積み上げていたが、実際の朔は平均から最大 ±0.6 日ずれるうえ、
   **月齢と旧暦日は別物**（朔が夕方なら、その日の正午の月齢はまだ 29 日台）。
   この 2 つが重なって、2026-08-09 は「長潮」と出ていた（正しくは中潮）。

   いまは Meeus『Astronomical Algorithms』49 章で**実際の朔の時刻**を求め、
   旧暦日（朔の日を 1 日目とする通日）から潮名を決める。
   気象庁の潮位表と突き合わせた検証は D-062 に書いた。 */

const RAD_PER_DEG = Math.PI / 180;

/** k 番目の朔の時刻（UTC ミリ秒）。誤差は数分。 */
function newMoonAt(k: number): number {
  const t = k / 1236.85;
  const jde = 2451550.09766 + 29.530588861 * k
    + 0.00015437 * t ** 2 - 0.000000150 * t ** 3 + 0.00000000073 * t ** 4;
  const e = 1 - 0.002516 * t - 0.0000074 * t ** 2;
  const sin = (deg: number) => Math.sin(deg * RAD_PER_DEG);
  const m = 2.5534 + 29.10535670 * k - 0.0000014 * t ** 2 - 0.00000011 * t ** 3;
  const mp = 201.5643 + 385.81693528 * k + 0.0107582 * t ** 2
    + 0.00001238 * t ** 3 - 0.000000058 * t ** 4;
  const f = 160.7108 + 390.67050284 * k - 0.0016118 * t ** 2
    - 0.00000227 * t ** 3 + 0.000000011 * t ** 4;
  const omega = 124.7746 - 1.56375588 * k + 0.0020672 * t ** 2 + 0.00000215 * t ** 3;

  const correction = -0.40720 * sin(mp)
    + 0.17241 * e * sin(m)
    + 0.01608 * sin(2 * mp)
    + 0.01039 * sin(2 * f)
    + 0.00739 * e * sin(mp - m)
    - 0.00514 * e * sin(mp + m)
    + 0.00208 * e * e * sin(2 * m)
    - 0.00111 * sin(mp - 2 * f)
    - 0.00057 * sin(mp + 2 * f)
    + 0.00056 * e * sin(2 * mp + m)
    - 0.00042 * sin(3 * mp)
    + 0.00042 * e * sin(m + 2 * f)
    + 0.00038 * e * sin(m - 2 * f)
    - 0.00024 * e * sin(2 * mp - m)
    - 0.00017 * sin(omega)
    - 0.00007 * sin(mp + 2 * m);

  const extra = [
    [0.000325, 299.77 + 0.107408 * k - 0.009173 * t ** 2],
    [0.000165, 251.88 + 0.016321 * k],
    [0.000164, 251.83 + 26.651886 * k],
    [0.000126, 349.42 + 36.412478 * k],
    [0.000110, 84.66 + 18.206239 * k],
    [0.000062, 141.74 + 53.303771 * k],
    [0.000060, 207.14 + 2.453732 * k],
    [0.000056, 154.84 + 7.306860 * k],
    [0.000047, 34.52 + 27.261239 * k],
    [0.000042, 207.19 + 0.121824 * k],
    [0.000040, 291.34 + 1.844379 * k],
    [0.000037, 161.72 + 24.198154 * k],
    [0.000035, 239.56 + 25.513099 * k],
    [0.000023, 331.55 + 3.592518 * k],
  ].reduce((sum, [amp, deg]) => sum + amp * sin(deg), 0);

  // TT → UTC は 2026 年ごろで約 69 秒。潮名には効かないが揃えておく
  const jd = jde + correction + extra;
  return (jd - 2451545.0) * 86400000 + Date.UTC(2000, 0, 1, 12) - 69000;
}

/** その時刻より前でいちばん近い朔（UTC ミリ秒）。 */
function newMoonBefore(ms: number): number {
  let k = Math.round((ms - Date.UTC(2000, 0, 6)) / 86400000 / 29.530588861);
  while (newMoonAt(k) > ms) k -= 1;
  while (newMoonAt(k + 1) <= ms) k += 1;
  return newMoonAt(k);
}

/** JST の "YYYY-MM-DD" → その日の JST 正午の UTC ミリ秒。 */
function jstNoonMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 3, 0);   // 12:00 JST = 03:00 UTC
}

/** UTC ミリ秒 → JST の "YYYY-MM-DD"。 */
function jstDateString(ms: number): string {
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

/**
 * JST 正午時点の月齢（小数第 1 位）。実際の朔からの経過日数。
 * 朔が夕方の日は、正午時点ではまだ 29 日台になる（暦の慣習どおり）。
 */
export function moonAge(isoDate: string): number {
  const noon = jstNoonMs(isoDate);
  return Math.round(((noon - newMoonBefore(noon)) / 86400000) * 10) / 10;
}

/**
 * 旧暦日（朔の日を 1 日目とする通日）。潮名はこれで決まる。
 * 月齢ではなく**日付**で数えるのがポイント（朔が何時であっても、その日が 1 日目）。
 */
export function lunarDay(isoDate: string): number {
  const noon = jstNoonMs(isoDate);
  // 朔がその日の正午より後でも「その日が 1 日目」なので、1 日先まで見て判定する
  const candidate = newMoonBefore(noon + 86400000);
  const start = jstDateString(candidate) <= isoDate ? candidate : newMoonBefore(noon);
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`)
    - Date.parse(`${jstDateString(start)}T00:00:00Z`)) / 86400000) + 1;
}

/** 潮回り。旧暦日から決める（潮見表と同じ対応表）。 */
export function tideType(isoDate: string): string {
  const day = lunarDay(isoDate);
  if ([1, 2, 3, 15, 16, 17, 18, 29, 30].includes(day)) return "大潮";
  if ([4, 5, 6, 12, 13, 14, 19, 20, 21, 27, 28].includes(day)) return "中潮";
  if ([7, 8, 9, 22, 23, 24].includes(day)) return "小潮";
  if ([10, 25].includes(day)) return "長潮";
  return "若潮";   // 11, 26
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
