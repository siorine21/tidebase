/* TIDEBASE 共通クライアント（認証・API アクセス・共通ロジック）。
   データアクセスは PostgREST + RLS、潮汐は Edge Function、天気は Open-Meteo（D-013・D-021）。 */

import { icon } from "./icons.js";

export { icon };

const config = window.TIDEBASE_CONFIG;

export const client = window.supabase.createClient(
  config.supabaseUrl,
  config.supabaseAnonKey,
);

/* ---------------- 認証 ---------------- */

/** 未ログインならログイン画面へ送る。ログイン済みならセッションを返す。 */
export async function requireSession() {
  const { data } = await client.auth.getSession();
  if (!data.session) {
    location.replace("login.html");
    return null;
  }
  return data.session;
}

/** ログイン済みなら遷移先へ送る（ログイン・登録画面用）。 */
export async function redirectIfSignedIn(destination = "index.html") {
  const { data } = await client.auth.getSession();
  if (data.session) location.replace(destination);
}

/** Supabase のエラーを日本語の一文にする。 */
export function toJapaneseError(error) {
  const message = error?.message ?? "";
  if (/Invalid login credentials/i.test(message)) {
    return "メールアドレスまたはパスワードが違います。";
  }
  if (/Email not confirmed/i.test(message)) {
    return "メールアドレスが未確認です。確認メールのリンクを開いてください。";
  }
  if (/User already registered|already been registered/i.test(message)) {
    return "このメールアドレスは登録済みです。ログインしてください。";
  }
  if (/Signups not allowed/i.test(message)) {
    return "現在、新規登録は受け付けていません。";
  }
  if (/Password should be at least/i.test(message)) {
    return "パスワードが短すぎます。";
  }
  if (/rate limit|too many/i.test(message)) {
    return "試行回数が多すぎます。しばらく待って再度お試しください。";
  }
  // PostgREST 側のエラー
  if (/row-level security/i.test(message)) {
    return "この操作を行う権限がありません。";
  }
  if (/duplicate key value/i.test(message)) {
    if (/makers_user_id_name_key/.test(message)) return "同じ名前のメーカーがすでに登録されています。";
    if (/tags_user_id_name_key/.test(message)) return "同じ名前のタグがすでに登録されています。";
    if (/fish_species/.test(message)) return "同じ名前の魚種がすでに登録されています。";
    return "同じ内容がすでに登録されています。";
  }
  if (/violates check constraint "spots_coordinates_in_japan"/.test(message)) {
    return "地図をタップして、日本国内の位置を指定してください。";
  }
  if (/釣果記録が/.test(message)) return message; // DB トリガーの日本語メッセージ
  return message || "処理に失敗しました。時間をおいて再度お試しください。";
}

/* ---------------- 日付（すべて JST 基準・D-011） ---------------- */

export function todayInJst() {
  return toJstDateString(new Date());
}

export function toJstDateString(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 現在時刻を JST で返す。端末のタイムゾーンが JST でなくても同じ結果になる。
 * @returns {{date: string, hour: number, minute: number, hours: number, hhmm: string}}
 *          hours は小数（14:30 なら 14.5）で、グラフの横位置計算に使う。
 */
export function nowInJst(base = new Date()) {
  const jst = new Date(base.getTime() + 9 * 60 * 60 * 1000);
  const hour = jst.getUTCHours();
  const minute = jst.getUTCMinutes();
  return {
    date: jst.toISOString().slice(0, 10),
    hour,
    minute,
    hours: hour + minute / 60,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function formatJstDate(isoDate, { weekday = false } = {}) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const label = `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`;
  if (!weekday) return label;
  return `${label} ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

export function formatShortDate(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${m}/${d}`;
}

/** 「4日前」のような相対表記。 */
export function relativeDays(isoDate) {
  const target = Date.parse(`${isoDate}T00:00:00+09:00`);
  const today = Date.parse(`${todayInJst()}T00:00:00+09:00`);
  const days = Math.round((today - target) / 86400000);
  if (days === 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 0) return `${-days}日後`;
  return `${days}日前`;
}

/* ---------------- 潮汐（Edge Function・認証不要） ---------------- */

/**
 * 応答が返らないまま止まると画面が「読み込み中…」のままになるので、
 * 外部 API への取得はすべて時間切れを付ける。
 */
const FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options = {}) {
  const { timeout = FETCH_TIMEOUT_MS, ...init } = options;
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
}

export async function fetchTide(station, date) {
  const url = `${config.supabaseUrl}/functions/v1/tide`
    + `?station=${encodeURIComponent(station)}&date=${encodeURIComponent(date)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`潮汐データを取得できませんでした (${response.status})`);
  return response.json();
}

/* ---------------- 月齢・潮回り（D-062） ----------------
   潮回りは「朔（新月）からの日数」で決まる。以前は朔望月の平均（29.530588853 日）を
   2000 年の朔から積み上げていたが、実際の朔は平均から最大 ±0.6 日ずれるうえ、
   **月齢と旧暦日は別物**（朔が夕方なら、その日の正午の月齢はまだ 29 日台）。
   この 2 つが重なって、2026-08-09 は「長潮」と出ていた（正しくは中潮）。

   いまは Meeus『Astronomical Algorithms』49 章で**実際の朔の時刻**を求め、
   旧暦日（朔の日を 1 日目とする通日）から潮名を決める。
   気象庁の潮位表と突き合わせた検証は D-062 に書いた。 */

const RAD_PER_DEG = Math.PI / 180;

/** k 番目の朔の時刻（UTC ミリ秒）。誤差は数分。 */
function newMoonAt(k) {
  const t = k / 1236.85;
  const jde = 2451550.09766 + 29.530588861 * k
    + 0.00015437 * t ** 2 - 0.000000150 * t ** 3 + 0.00000000073 * t ** 4;
  const e = 1 - 0.002516 * t - 0.0000074 * t ** 2;
  const sin = (deg) => Math.sin(deg * RAD_PER_DEG);
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
function newMoonBefore(ms) {
  let k = Math.round((ms - Date.UTC(2000, 0, 6)) / 86400000 / 29.530588861);
  while (newMoonAt(k) > ms) k -= 1;
  while (newMoonAt(k + 1) <= ms) k += 1;
  return newMoonAt(k);
}

/** JST の "YYYY-MM-DD" → その日の JST 正午の UTC ミリ秒。 */
function jstNoonMs(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 3, 0);   // 12:00 JST = 03:00 UTC
}

/** UTC ミリ秒 → JST の "YYYY-MM-DD"。 */
function jstDateString(ms) {
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

/**
 * JST 正午時点の月齢（小数第 1 位）。実際の朔からの経過日数。
 * 朔が夕方の日は、正午時点ではまだ 29 日台になる（暦の慣習どおり）。
 */
export function moonAge(isoDate) {
  const noon = jstNoonMs(isoDate);
  return Math.round(((noon - newMoonBefore(noon)) / 86400000) * 10) / 10;
}

/**
 * 旧暦日（朔の日を 1 日目とする通日）。潮名はこれで決まる。
 * 月齢ではなく**日付**で数えるのがポイント（朔が何時であっても、その日が 1 日目）。
 */
export function lunarDay(isoDate) {
  const noon = jstNoonMs(isoDate);
  // 朔がその日の正午より後でも「その日が 1 日目」なので、1 日先まで見て判定する
  const candidate = newMoonBefore(noon + 86400000);
  const start = jstDateString(candidate) <= isoDate ? candidate : newMoonBefore(noon);
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`)
    - Date.parse(`${jstDateString(start)}T00:00:00Z`)) / 86400000) + 1;
}

/** 潮回り。旧暦日から決める（潮見表と同じ対応表）。 */
export function tideType(isoDate) {
  const day = lunarDay(isoDate);
  if ([1, 2, 3, 15, 16, 17, 18, 29, 30].includes(day)) return "大潮";
  if ([4, 5, 6, 12, 13, 14, 19, 20, 21, 27, 28].includes(day)) return "中潮";
  if ([7, 8, 9, 22, 23, 24].includes(day)) return "小潮";
  if ([10, 25].includes(day)) return "長潮";
  return "若潮";   // 11, 26
}

/** 潮回りの表示色（ワイヤーフレーム v7.2 の週間カレンダー）。 */
export const TIDE_TYPE_COLORS = {
  大潮: "#FF5722",
  中潮: "#FF9800",
  小潮: "#64B5F6",
  長潮: "#9AA5B1",
  若潮: "#4CAF50",
};

/* ---------------- 潮汐グラフ（時間軸で連続・D-036） ----------------
   ホーム（SCR-001）と潮汐詳細（SCR-003）で同じ描画を使う。
   夜釣りは日をまたぐので、日単位で区切らず 1 本の曲線としてつなぐ。 */

/** 毎時値を線形補間して任意の時刻の潮位を求める。 */
export function tideLevelAt(levels, hours) {
  const i = Math.floor(hours);
  const a = levels?.[Math.min(i, 23)], b = levels?.[Math.min(i + 1, 23)];
  if (a == null) return null;
  if (b == null) return a;
  return a + (b - a) * (hours - i);
}

/**
 * 指定時刻の潮位と、そのときの潮の向き。
 * 「何時に釣れたか」から「そのとき潮位はいくつで、上げていたか下げていたか」を出す。
 * 前後 30 分の差で向きを見る（毎時値の線形補間なので、これ以上細かくしても精度は上がらない）。
 */
export function tideAt(tide, hhmm) {
  const hours = hoursFromHhmm(hhmm);
  if (hours == null || !tide) return null;
  const levels = tide.hourly_levels_cm;
  const level = tideLevelAt(levels, Math.min(hours, 23));
  if (level == null) return null;

  const before = tideLevelAt(levels, Math.max(0, hours - 0.5));
  const after = tideLevelAt(levels, Math.min(23, hours + 0.5));
  const delta = (after ?? level) - (before ?? level);
  const trend = Math.abs(delta) < 1 ? "潮止まり前後" : delta > 0 ? "上げ潮" : "下げ潮";
  return { level: Math.round(level), trend };
}

/**
 * 単調 3 次補間（Fritsch–Carlson）で滑らかな SVG パスを作る。
 * 毎時の点を直線でつなぐとカクカクするため。単調性を保つ方式なので、
 * 補間で元データの範囲を超えて上下に飛び出すことがない（軸を突き抜けない）。
 * @param {{x:number,y:number}[]} points x 昇順の点列
 */
export function smoothPath(points) {
  if (points.length < 2) return points.length ? `M${points[0].x},${points[0].y}` : "";

  const n = points.length;
  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
  }

  // 各点の傾き（両隣の平均）を求め、単調性が崩れる場合は抑える
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = points[i].x + dx[i] / 3;
    const c1y = points[i].y + (m[i] * dx[i]) / 3;
    const c2x = points[i + 1].x - dx[i] / 3;
    const c2y = points[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)}`
      + ` ${points[i + 1].x.toFixed(2)},${points[i + 1].y.toFixed(2)}`;
  }
  return d;
}

const WEEKDAYS_SHORT = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 複数日を 1 本につないだ潮位グラフの SVG を返す。
 * @param {object} options
 * @param {string[]} options.days      連続した日付（昇順）
 * @param {object[]} options.tides     days と同じ並びの潮汐（未取得は null）
 * @param {Map<string,object>} options.suns 日付 → {rise, set}
 * @param {string} options.today       今日の日付（TODAY 表示用）
 * @param {number} options.dayUnits    1 日ぶんの viewBox 幅（= 画面 1 枚ぶん）
 * @returns {{svg: string, min: number, max: number}|null} データが無ければ null
 */
export function tideTimelineSvg({
  days, tides, suns = new Map(), today = null, marker = null,
  dayUnits = 320, height = 176, padTop = 30, padBottom = 30,
}) {
  const width = dayUnits * days.length;
  const totalHours = days.length * 24;

  // 毎時値に加えて満潮・干潮の実測値も曲線に含める。
  // JMA の満干は毎時値の最大／最小を超えることがあり（例: 毎時 115cm / 満潮 116cm）、
  // 毎時値だけで描くと満干の点が曲線から浮く。
  const samples = days.map((date, d) => {
    const tide = tides[d];
    if (!tide) return null;
    const list = [];
    (tide.hourly_levels_cm ?? []).forEach((v, h) => {
      if (v != null) list.push({ h: d * 24 + h, v });
    });
    for (const e of [...(tide.high_tides ?? []), ...(tide.low_tides ?? [])]) {
      const hours = hoursFromHhmm(e.time);
      if (hours == null || e.level_cm == null) continue;
      list.push({ h: d * 24 + hours, v: e.level_cm, peak: true });
    }
    list.sort((a, b) => a.h - b.h);
    // 満干が毎時値とほぼ同時刻なら実測値を優先する
    return list.filter((pt, i) => {
      const next = list[i + 1];
      return !(next && Math.abs(next.h - pt.h) < 1 / 60 && next.peak && !pt.peak);
    });
  });

  const all = samples.flatMap((list) => list?.map((pt) => pt.v) ?? []);
  if (!all.length) return null;

  const min = Math.min(...all), max = Math.max(...all);
  const x = (hours) => (hours / totalHours) * width;
  const y = (v) => height - padBottom
    - ((v - min) / Math.max(1, max - min)) * (height - padTop - padBottom);

  // 曲線は日をまたいでつなぐ。未取得の日はそこで区切る
  const segments = [];
  let current = [];
  samples.forEach((list) => {
    if (!list) { if (current.length) segments.push(current); current = []; return; }
    for (const pt of list) current.push({ x: x(pt.h), y: y(pt.v) });
  });
  if (current.length) segments.push(current);

  const lines = segments.map((pts) => `<path class="curve-line" d="${smoothPath(pts)}"/>`).join("");
  const areas = segments.map((pts) => {
    const base = height - padBottom;
    return `<path class="curve-area" d="${smoothPath(pts)} L${pts[pts.length - 1].x.toFixed(2)},${base}`
      + ` L${pts[0].x.toFixed(2)},${base} Z"/>`;
  }).join("");

  // 夜（日の出前・日没後）を塗る。夜釣りの時間帯が帯で分かる。
  // あわせて日の出・日没の位置を控えておく（アイコンは SVG の外に置く。D-053）
  const sunMarks = [];
  const nights = days.map((date, d) => {
    const sun = suns.get?.(date) ?? suns[date];
    if (!sun) return "";
    const rise = hoursFromHhmm(sun.rise), set = hoursFromHhmm(sun.set);
    if (rise == null || set == null) return "";
    sunMarks.push(
      { kind: "rise", hhmm: sun.rise, left: ((d * 24 + rise) / totalHours) * 100 },
      { kind: "set", hhmm: sun.set, left: ((d * 24 + set) / totalHours) * 100 });
    const band = (from, to) => `<rect class="night" x="${x(d * 24 + from)}" y="${padTop - 8}"
      width="${Math.max(0, x(d * 24 + to) - x(d * 24 + from))}"
      height="${height - padBottom - padTop + 8}"/>`;
    return band(0, rise) + band(set, 24);
  }).join("");

  // 日の出・日没の縦線。夜の帯の境目そのものだが、線があると時刻を読み取りやすい
  const sunLines = sunMarks.map((m) => {
    const sx = (m.left / 100) * width;
    return `<line class="sun-line" x1="${sx}" y1="${padTop - 8}" x2="${sx}" y2="${height - padBottom}"/>`;
  }).join("");

  // 潮位の横目盛り。何センチかを読み取れるようにする（D-054）
  const levelTicks = niceLevelTicks(min, max).map((cm) => ({ cm, y: y(cm) }));
  const levelLines = levelTicks.map((t) =>
    `<line class="level-line" x1="0" y1="${t.y.toFixed(2)}" x2="${width}" y2="${t.y.toFixed(2)}"/>`
  ).join("");

  // 目盛り: 2 時間ごとに細い線、6 時間ごとに太めの線と時刻ラベル
  const grid = days.flatMap((date, d) => {
    const marks = [];
    for (let h = 0; h < 24; h += 2) {
      if (h === 0) continue;                       // 0 時は日境界の線が担う
      const cls = h % 6 === 0 ? "grid" : "grid-minor";
      marks.push(`<line class="${cls}" x1="${x(d * 24 + h)}" y1="${padTop - 8}"
        x2="${x(d * 24 + h)}" y2="${height - padBottom}"/>`);
    }
    // 0 時のところは時刻ではなく日付を出す（D-057）。
    // 日付を上に置くと、満潮のときに「満 15:32」とぶつかって読めなくなる。
    // 日境界＝0 時なので、時刻を省いても位置は分からなくならない。
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    marks.push(`<text class="day-label" x="${x(d * 24) + 4}" y="${height - 10}">${
      date.slice(5).replace("-", "/")} ${WEEKDAYS_SHORT[weekday]}${
      date === today ? " TODAY" : ""}</text>`);
    for (const h of [6, 12, 18]) {
      marks.push(`<text x="${x(d * 24 + h) + 3}" y="${height - 10}">${h}:00</text>`);
    }
    return marks;
  }).join("");

  // 日境界。線の上端は目盛り線と揃える（上に日付を置かなくなったので 0 まで伸ばさない）
  const boundaries = days.map((date, d) =>
    `<line class="day-line" x1="${x(d * 24)}" y1="${padTop - 8}"
       x2="${x(d * 24)}" y2="${height - padBottom}"/>`).join("");

  // 満潮・干潮
  const marks = days.flatMap((date, d) => {
    const tide = tides[d];
    if (!tide) return [];
    return [
      ...(tide.high_tides ?? []).map((e) => ({ ...e, kind: "high", mark: "満" })),
      ...(tide.low_tides ?? []).map((e) => ({ ...e, kind: "low", mark: "干" })),
    ].filter((e) => e.time).map((e) => {
      const hours = hoursFromHhmm(e.time);
      const cx = x(d * 24 + hours);
      const cy = e.level_cm != null ? y(e.level_cm)
        : y(tideLevelAt(tide.hourly_levels_cm, hours) ?? min);
      // 干潮は点の下だが、谷が深いと時刻の目盛りと重なるので上へ逃がす
      const ty = e.kind === "high" || cy > height - padBottom - 18 ? cy - 10 : cy + 15;
      return `
        <circle class="peak-dot ${e.kind}" cx="${cx}" cy="${cy}" r="3.5"/>
        <text class="peak ${e.kind}" x="${cx}" y="${ty}" text-anchor="middle">${e.mark} ${e.time}</text>`;
    });
  }).join("");

  // 現在時刻
  const now = nowInJst();
  const nowIndex = days.indexOf(now.date);
  let nowMark = "";
  if (nowIndex >= 0) {
    const hours = Math.min(now.hours, 23);
    const nx = x(nowIndex * 24 + hours);
    const level = tideLevelAt(tides[nowIndex]?.hourly_levels_cm, hours);
    nowMark = `<line class="now" x1="${nx}" y1="${padTop - 8}" x2="${nx}" y2="${height - padBottom}"/>`
      + (level != null ? `<circle class="now-dot" cx="${nx}" cy="${y(level)}" r="4"/>` : "");
  }

  // 任意の時刻の印（釣れた時刻など）。{ date, hhmm, label } を渡す
  let markerMark = "";
  const markerIndex = marker ? days.indexOf(marker.date) : -1;
  if (markerIndex >= 0) {
    const hours = hoursFromHhmm(marker.hhmm);
    if (hours != null) {
      const mx = x(markerIndex * 24 + Math.min(hours, 23.999));
      const level = tideLevelAt(tides[markerIndex]?.hourly_levels_cm, Math.min(hours, 23));
      markerMark =
        `<line class="catch-line" x1="${mx}" y1="${padTop - 8}" x2="${mx}" y2="${height - padBottom}"/>`
        + (level != null ? `<circle class="catch-dot" cx="${mx}" cy="${y(level)}" r="5"/>` : "")
        + (marker.label
          ? `<text class="catch-label" x="${mx}" y="${padTop - 12}" text-anchor="middle">${
              escapeHtml(marker.label)}</text>`
          : "");
    }
  }

  const svg = `
    <svg class="tide-graph tide-graph-lg" viewBox="0 0 ${width} ${height}"
         preserveAspectRatio="none" role="img"
         aria-label="${days[0]} から ${days[days.length - 1]} までの潮位グラフ">
      ${nights}
      ${grid}
      ${levelLines}
      ${sunLines}
      <line class="axis" x1="0" y1="${height - padBottom}" x2="${width}" y2="${height - padBottom}"/>
      ${areas}
      ${lines}
      ${boundaries}
      ${nowMark}
      ${marks}
      ${markerMark}
    </svg>`;
  return { svg, min, max, sunMarks, levelTicks };
}

/**
 * 潮位の目盛り値。線が 4 本前後になる刻みを選ぶ。
 * 「きりのいい数字」に寄せるので、20cm 刻み・25cm 刻み…のどれかになる。
 */
function niceLevelTicks(min, max) {
  const span = Math.max(1, max - min);
  // 刻みが粗すぎると線が 1 本しか引けない（潮位差が小さい日でも 2〜3 本は欲しい）
  const steps = [2, 5, 10, 20, 25, 50, 100, 200, 500];
  const step = steps.find((s) => span / s <= 4) ?? steps[steps.length - 1];
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

/**
 * 潮位の目盛りラベル。グラフの**外**に重ねて置く（横スクロールしても残るように）。
 * 縦方向は引き伸ばしていないので、SVG の座標がそのまま px として使える。
 * 置き場所の高さは呼び出し側で SVG と同じ値にすること。
 * @param {{cm:number, y:number}[]} ticks tideTimelineSvg の戻り値
 */
export function levelAxisHtml(ticks) {
  if (!ticks?.length) return "";
  // 上から並べる（配列は cm 昇順＝画面では下から）
  return [...ticks].reverse().map((t, i) =>
    `<span style="top:${t.y.toFixed(2)}px">${t.cm}${i === 0 ? "cm" : ""}</span>`).join("");
}

/**
 * 日の出・日没の印。グラフの下に重ねる帯として返す。
 *
 * SVG の中に描かない理由: グラフは `preserveAspectRatio="none"` で横に引き伸ばして
 * いるので、中に置いたアイコンは丸が楕円に潰れる。帯を外に出せば、
 * 位置だけ % で合わせて形はそのまま保てる（親の幅が何 % でも位置は狂わない）。
 * @param {{kind:string, hhmm:string, left:number}[]} marks tideTimelineSvg の戻り値
 */
export function sunStripHtml(marks) {
  if (!marks?.length) return "";
  return `<div class="sun-strip">${marks.map((m) => `
    <span class="sun-mark ${m.kind}" style="left:${m.left.toFixed(3)}%">
      ${icon(m.kind === "rise" ? "sunrise" : "sunset", { size: 12 })}
      <span>${escapeHtml(m.hhmm)}</span>
    </span>`).join("")}</div>`;
}

/* ---------------- 潮汐地点（細分化・D-030） ---------------- */

/** 気象庁の潮位表地点。pref を指定すると絞り込む（既定は静岡県）。 */
export async function listTideStations({ pref = "静岡県" } = {}) {
  let query = client.from("tide_stations").select("code, name, lat, lng, pref").order("lng");
  if (pref) query = query.eq("pref", pref);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** 潮位表地点がない場所の細分地点（基準観測点＋時差・潮高比）。 */
export async function listTideAreas({ pref = "静岡県" } = {}) {
  let query = client
    .from("tide_areas")
    .select("code, name, pref, water_body, base_station_code, lag_minutes, level_ratio, lat, lng, note, source")
    .order("water_body")
    .order("lag_minutes");
  if (pref) query = query.eq("pref", pref);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * 潮汐地点の選択肢。観測点（補正なし）と細分地点（補正あり）をまとめて返す。
 * value は "ST:MI" / "AR:HN-MURAKUSHI" の形式で、そのまま localStorage に持てる。
 */
export async function listTidePoints({ pref = "静岡県" } = {}) {
  const [stations, areas] = await Promise.all([
    listTideStations({ pref }).catch(() => []),
    listTideAreas({ pref }).catch(() => []),
  ]);
  const stationName = new Map(stations.map((s) => [s.code, s.name]));
  return [
    ...stations.map((s) => ({
      value: `ST:${s.code}`, group: "潮位表地点（気象庁）", label: s.name, name: s.name,
      station: s.code, area: null, lagMinutes: 0, levelRatio: 1,
      lat: Number(s.lat), lng: Number(s.lng),
    })),
    ...areas.map((a) => ({
      value: `AR:${a.code}`,
      group: `${a.water_body ?? a.pref}（推算）`,
      label: a.lag_minutes
        ? `${a.name}（${stationName.get(a.base_station_code) ?? a.base_station_code} ${formatLag(a.lag_minutes)}）`
        : `${a.name}（${stationName.get(a.base_station_code) ?? a.base_station_code} と同時刻）`,
      name: a.name,
      station: a.base_station_code, area: a.code,
      lagMinutes: a.lag_minutes, levelRatio: Number(a.level_ratio),
      lat: Number(a.lat), lng: Number(a.lng),
      baseName: stationName.get(a.base_station_code) ?? a.base_station_code,
      note: a.note, source: a.source,
    })),
  ];
}

/** 時差を「+2:00」の形で表す。 */
export function formatLag(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** localStorage に保存した潮汐地点の選択。 */
export function savedTidePoint() {
  return localStorage.getItem("tidebase.tidePoint");
}
export function saveTidePoint(value) {
  if (value) localStorage.setItem("tidebase.tidePoint", value);
  else localStorage.removeItem("tidebase.tidePoint");
}

/**
 * お気に入りの潮汐地点（SCR-003 の地点切替タブ）。端末をまたいで同じ並びに
 * したいので profiles に持つ。存在しない地点コードは読み飛ばす。
 */
export async function listFavoriteTidePoints(points) {
  const userId = await currentUserId();
  if (!userId) return [];
  const { data, error } = await client
    .from("profiles").select("favorite_tide_points").eq("id", userId).maybeSingle();
  if (error) throw error;
  const byValue = new Map(points.map((p) => [p.value, p]));
  return (data?.favorite_tide_points ?? []).map((v) => byValue.get(v)).filter(Boolean);
}

export async function saveFavoriteTidePoints(values) {
  const userId = await requireUserId();
  const { error } = await client
    .from("profiles").update({ favorite_tide_points: values }).eq("id", userId);
  if (error) throw error;
}

/** JST 基準で日付を進める / 戻す。 */
export function addJstDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000)
    .toISOString().slice(0, 10);
}

/** その日を含む週（日曜始まり）の日付 7 件。 */
export function weekOf(isoDate) {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();  // 0 = 日曜
  const sunday = addJstDays(isoDate, -weekday);
  return Array.from({ length: 7 }, (_, i) => addJstDays(sunday, i));
}

/** スポットに紐付いた潮汐地点を選択肢の value 形式で返す。 */
export function tidePointOfSpot(spot) {
  if (!spot) return null;
  if (spot.tide_area_code) return `AR:${spot.tide_area_code}`;
  if (spot.tide_station_code) return `ST:${spot.tide_station_code}`;
  return null;
}

/**
 * 潮汐地点の推算値を取得する。細分地点は基準観測点の推算値に
 * 時差（lagMinutes）と潮高比（levelRatio）を掛けて推定する。
 * 潮高比は日内の平均潮位まわりでかける（潮見表の潮高改正と同じ考え方）。
 */
export async function fetchTideForPoint(point, date) {
  const base = await fetchTide(point.station, date);
  if (!point.area || (!point.lagMinutes && point.levelRatio === 1)) {
    return { ...base, point, corrected: false };
  }

  // 時差ぶん前の時刻の潮位を読む必要があるため、前日ぶんもつなげる
  const previous = point.lagMinutes > 0
    ? await fetchTide(point.station, addDays(date, -1)).catch(() => null)
    : null;
  const next = point.lagMinutes < 0
    ? await fetchTide(point.station, addDays(date, 1)).catch(() => null)
    : null;

  const series = [
    ...(previous?.hourly_levels_cm ?? Array(24).fill(null)),
    ...base.hourly_levels_cm,
    ...(next?.hourly_levels_cm ?? Array(24).fill(null)),
  ];
  const known = base.hourly_levels_cm.filter((v) => v != null);
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const lagHours = point.lagMinutes / 60;

  const shifted = Array.from({ length: 24 }, (_, hour) => {
    const level = interpolate(series, 24 + hour - lagHours);
    if (level == null) return null;
    return Math.round(mean + (level - mean) * point.levelRatio);
  });

  return {
    ...base,
    hourly_levels_cm: shifted,
    high_tides: shiftEvents(base.high_tides, point.lagMinutes),
    low_tides: shiftEvents(base.low_tides, point.lagMinutes),
    point,
    corrected: true,
    base_station: base.station,
  };
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** 連続した毎時系列を線形補間する（index は小数可）。 */
function interpolate(series, index) {
  const i = Math.floor(index);
  const a = series[i], b = series[i + 1];
  if (a == null) return null;
  if (b == null) return a;
  return a + (b - a) * (index - i);
}

/** 満潮・干潮の時刻を時差ぶんずらす。日をまたぐものは落とす。 */
function shiftEvents(events, lagMinutes) {
  return (events ?? []).flatMap((e) => {
    if (!e.time) return [];
    const [h, m] = e.time.split(":").map(Number);
    const total = h * 60 + m + lagMinutes;
    if (total < 0 || total >= 24 * 60) return [];   // 前日・翌日に出るぶんは表示しない
    return [{
      ...e,
      time: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
    }];
  });
}

/* ---------------- 天気（Open-Meteo・API キー不要） ---------------- */

const WMO = {
  0: ["快晴", "sun"], 1: ["晴れ", "cloud-sun"], 2: ["一部曇り", "cloud-sun"], 3: ["曇り", "cloud"],
  45: ["霧", "fog"], 48: ["霧", "fog"],
  51: ["霧雨", "rain"], 53: ["霧雨", "rain"], 55: ["霧雨", "rain"],
  61: ["小雨", "rain"], 63: ["雨", "rain"], 65: ["大雨", "rain"],
  71: ["雪", "snow"], 73: ["雪", "snow"], 75: ["大雪", "snow"],
  80: ["にわか雨", "rain"], 81: ["にわか雨", "rain"], 82: ["激しい雨", "rain"],
  95: ["雷雨", "storm"], 96: ["雷雨", "storm"], 99: ["雷雨", "storm"],
};

export function describeWeather(code) {
  const [label, iconName] = WMO[code] ?? ["—", "thermometer"];
  return { label, iconName, icon: icon(iconName, { size: 20 }) };
}

/** WMO コード → 釣行スコア用の天気区分（設計補完書 7 章）。 */
export function weatherCategory(code) {
  if (code >= 95) return "storm";
  if ((code >= 51 && code <= 82) || (code >= 71 && code <= 77)) return "rain";
  if (code === 3 || code === 45 || code === 48) return "cloudy";
  return "sunny";
}

const WIND_DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
export function windDirection(degrees) {
  return WIND_DIRS[Math.round(degrees / 45) % 8];
}

/**
 * 指定座標・指定日の 1 時間刻み予報と、その日の日の出・日没。
 * 波高は海上グリッド外だと null になる（設計補完書 1.1 章）。
 * @returns {{hours: object[], sun: {rise: string, set: string}|null}}
 *          sun の時刻は "HH:MM"（JST）。極夜・白夜では null になり得る。
 */
export async function fetchWeather(lat, lng, date) {
  // 「0 時から 24 時間後まで」を満たすため翌日 0 時まで取得する（確定仕様書 2.2 章）
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const base = `latitude=${lat}&longitude=${lng}&timezone=Asia%2FTokyo`
    + `&start_date=${date}&end_date=${nextDay}`;
  const forecastUrl = "https://api.open-meteo.com/v1/forecast?" + base
    + "&hourly=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";
  const marineUrl = "https://marine-api.open-meteo.com/v1/marine?" + base + "&hourly=wave_height";

  const [forecastRes, marineRes] = await Promise.all([
    fetchWithTimeout(forecastUrl),
    fetchWithTimeout(marineUrl).catch(() => null),
  ]);
  if (!forecastRes.ok) throw new Error(`天気データを取得できませんでした (${forecastRes.status})`);

  const forecast = await forecastRes.json();
  let waves = null;
  if (marineRes && marineRes.ok) {
    const marine = await marineRes.json();
    waves = marine.hourly?.wave_height ?? null;
  }

  // 日の出・日没は計算で出す（D-056）。API から取ると過去 3 か月しか遡れない
  return { hours: mapHourly(forecast.hourly, waves), sun: sunTimes(lat, lng, date) };
}

/** Open-Meteo の hourly（配列の束）を 1 時間 1 件の形に直す。 */
function mapHourly(h, waves = null) {
  return h.time.map((time, i) => ({
    time,
    hour: Number(time.slice(11, 13)),
    temp_c: h.temperature_2m[i],
    weather_code: h.weather_code[i],
    wind_speed_ms: h.wind_speed_10m[i],
    wind_dir_deg: h.wind_direction_10m[i],
    wave_height_m: waves ? waves[i] : null,
  }));
}

/**
 * 複数日ぶんの時間別予報と日の出・日没を **1 リクエストで**まとめて取る（D-055）。
 * 週間カレンダーに釣行スコアを出すのに使う。日ごとに叩くと 7 往復になってしまう。
 *
 * 各日の hours には翌日 0 時の 1 件を足してある（「24 時間後まで」を満たすため。
 * 単日の fetchWeather と同じ形にして、そのまま使い回せるようにしている）。
 * 予報の届かない日（16 日より先など）はキーごと入らない。
 * @returns {Promise<Map<string, {hours: object[], sun: {rise:string,set:string}|null}>>}
 */
export async function fetchWeatherRange(lat, lng, startDate, endDate) {
  const last = new Date(Date.parse(`${endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const url = "https://api.open-meteo.com/v1/forecast?"
    + `latitude=${lat}&longitude=${lng}&timezone=Asia%2FTokyo`
    + `&start_date=${startDate}&end_date=${last}`
    + "&hourly=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";

  const result = new Map();
  let forecast;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return result;
    forecast = await response.json();
  } catch {
    return result;      // 天気が出なくても潮回りは表示できる
  }
  if (!forecast.hourly?.time) return result;

  const byDate = new Map();
  for (const row of mapHourly(forecast.hourly)) {
    const date = row.time.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }

  for (const [date, hours] of byDate) {
    if (date > endDate) continue;                       // 翌日 0 時を足すためだけに取った日
    const nextMidnight = byDate.get(addDays(date, 1))?.[0];
    result.set(date, {
      hours: nextMidnight ? [...hours, nextMidnight] : hours,
      sun: sunTimes(lat, lng, date),                    // 日の出・日没は計算（D-056）
    });
  }
  return result;
}

/**
 * 日本国内とみなせる座標か。天気・日の出日没は座標が違うと平然と別の場所の値を
 * 返してしまうため（(0,0) だと大西洋ギニア湾になる）、使う前に必ず通す。
 */
export function isCoordinateInJapan(lat, lng) {
  const y = Number(lat), x = Number(lng);
  return Number.isFinite(y) && Number.isFinite(x)
    && y >= 20 && y <= 46 && x >= 122 && x <= 154;
}


/** "HH:MM" を小数の時刻に変換する（グラフの横位置計算用）。 */
export function hoursFromHhmm(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : null;
}

/* ---------------- 釣行スコア（設計補完書 7 章・D-018） ---------------- */

/**
 * 釣行スコアの判定規則。上から順に当てはめ、最初に一致したものを採用する。
 * 画面の説明と実装がずれないよう、判定そのものをこの表から行う（D-050）。
 */
export const FISHING_SCORE_RULES = [
  {
    score: 1, label: "雷雨、または風速 15m/s 以上",
    match: (t, w, wind) => w === "storm" || wind >= 15,
  },
  {
    score: 2, label: "雨・雪、または風速 10m/s 超",
    match: (t, w, wind) => w === "rain" || wind > 10,
  },
  {
    score: 5, label: "大潮 + 晴れか曇り + 風速 5m/s 以下",
    match: (t, w, wind) => t === "大潮" && (w === "sunny" || w === "cloudy") && wind <= 5,
  },
  {
    score: 4, label: "中潮 + 晴れか曇り + 風速 7m/s 以下",
    match: (t, w, wind) => t === "中潮" && (w === "sunny" || w === "cloudy") && wind <= 7,
  },
  { score: 3, label: "上のどれにも当てはまらない", match: () => true },
];

/** スコアと、その根拠になった規則。画面で「なぜこの点か」を出すのに使う。 */
export function fishingScoreDetail(tideType, weatherCode, windMs) {
  const weather = weatherCategory(weatherCode);
  const wind = Number(windMs) || 0;
  const index = FISHING_SCORE_RULES.findIndex((r) => r.match(tideType, weather, wind));
  return { score: FISHING_SCORE_RULES[index].score, ruleIndex: index, weather, wind };
}

export function fishingScore(tideType, weatherCode, windMs) {
  return fishingScoreDetail(tideType, weatherCode, windMs).score;
}

const WEATHER_CATEGORY_LABELS = {
  sunny: "晴れ", cloudy: "曇り", rain: "雨・雪", storm: "雷雨",
};

/* ---- 日の出・日没（D-056） --------------------------------------------- */

const RAD = Math.PI / 180;

/**
 * 日の出・日没（JST の "HH:MM"）。天文計算なので通信は要らない。
 *
 * API から取らない理由: Open-Meteo の予報は**過去 3 か月ぶんしか遡れない**。
 * 釣果は何年も残るものなので、去年の釣行に「朝マヅメだったか」を出せなくなる。
 * 計算なら何年前でも何年先でも出せて、圏外でも動く。
 *
 * 標準的な日の出方程式（太陽の視半径と大気差ぶんの -0.833°を含む）。
 * 誤差は日本の緯度で 1 分程度で、マヅメの判定には十分。
 * @returns {{rise: string, set: string}|null} 白夜・極夜では null
 */
export function sunTimes(lat, lng, date) {
  // Number(null) も Number("") も 0 になる。0 は赤道の有効な緯度なので、
  // ここで弾かないと「座標が無い」が「ギニア湾の日の出」に化ける
  if (lat == null || lat === "" || lng == null || lng === "" || !date) return null;
  const y = Number(lat), x = Number(lng);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;

  // JST 正午のユリウス日を基準にする（その日の太陽の位置を代表させる）
  const jdNoon = Date.parse(`${date}T03:00:00Z`) / 86400000 + 2440587.5;
  if (!Number.isFinite(jdNoon)) return null;

  const n = Math.round(jdNoon - 2451545.0 + 0.0008);
  const jStar = n - x / 360;                                    // 平均太陽正午
  const m = (357.5291 + 0.98560028 * jStar) % 360;              // 太陽平均近点角
  const c = 1.9148 * Math.sin(m * RAD)
    + 0.02 * Math.sin(2 * m * RAD)
    + 0.0003 * Math.sin(3 * m * RAD);                           // 中心差
  const lambda = (m + c + 180 + 102.9372) % 360;                // 黄経
  const jTransit = 2451545.0 + jStar
    + 0.0053 * Math.sin(m * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));

  const cosOmega = (Math.sin(-0.833 * RAD) - Math.sin(y * RAD) * Math.sin(decl))
    / (Math.cos(y * RAD) * Math.cos(decl));
  if (cosOmega > 1 || cosOmega < -1) return null;               // 一日中夜／一日中昼
  const omega = Math.acos(cosOmega) / RAD;

  return { rise: jdToJstHhmm(jTransit - omega / 360), set: jdToJstHhmm(jTransit + omega / 360) };
}

/**
 * ユリウス日 → JST の "HH:MM"。
 * 秒は**切り捨てる**（四捨五入すると Open-Meteo の値より systematically 1 分遅くなる。
 * 実測で平均 +0.5 分ずれていた）。
 */
function jdToJstHhmm(jd) {
  const jst = new Date(Math.floor(((jd - 2440587.5) * 86400000 + 9 * 3600000) / 60000) * 60000);
  return `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

/* ---- マヅメ（D-051） --------------------------------------------------- */

/**
 * その日の朝マヅメ・夕マヅメ。日の出・日没そのものを中心時刻とする。
 * 実際に竿を出すのは前後 1 時間ほどだが、1 時間刻みの予報から代表値を 1 つ選ぶので、
 * 中心にいちばん近い時刻の予報を使う。
 * @param {{rise: string, set: string}|null} sun "HH:MM"（JST）
 */
export function mazumeWindows(sun) {
  if (!sun?.rise || !sun?.set) return [];
  return [
    { key: "morning", label: "朝マヅメ", at: sun.rise },
    { key: "evening", label: "夕マヅメ", at: sun.set },
  ];
}

/**
 * 指定時刻にいちばん近いマヅメと、そこからのずれ。
 * 「その 1 匹はマヅメだったのか」を釣果詳細に出すのに使う（D-056）。
 * @returns {{label:string, at:string, diffMinutes:number}|null} diff は正なら「後」
 */
export function nearestMazume(sun, hhmm) {
  const at = hoursFromHhmm(hhmm);
  const windows = mazumeWindows(sun);
  if (at == null || !windows.length) return null;
  return windows
    .map((w) => ({ ...w, diffMinutes: Math.round((at - hoursFromHhmm(w.at)) * 60) }))
    .reduce((a, b) => (Math.abs(b.diffMinutes) < Math.abs(a.diffMinutes) ? b : a));
}

/** マヅメとみなす幅（中心から前後）。 */
export const MAZUME_WINDOW_MINUTES = 60;

/** 「朝マヅメ 05:04 の 18 分後」のような文言。 */
export function mazumeLabel(near) {
  if (!near) return null;
  const d = near.diffMinutes;
  const abs = Math.abs(d);
  const span = abs >= 60
    ? `${Math.floor(abs / 60)} 時間${abs % 60 ? ` ${abs % 60} 分` : ""}`
    : `${abs} 分`;
  const when = d === 0 ? "ちょうど" : `${span}${d > 0 ? "後" : "前"}`;
  return {
    text: `${near.label} ${near.at} ${when}`,
    inWindow: abs <= MAZUME_WINDOW_MINUTES,
  };
}

/** "HH:MM" にいちばん近い時刻の予報。 */
function hourNearest(hours, hhmm) {
  const target = hoursFromHhmm(hhmm);
  if (!hours?.length || target == null) return null;
  return hours.reduce((best, row) =>
    Math.abs(row.hour - target) < Math.abs(best.hour - target) ? row : best);
}

/* ---- 潮の動きによる加減点（D-052） ------------------------------------- */

/** 「潮が止まっている」とみなす流速。その日いちばん速い流れに対する割合。 */
const SLACK_RATIO = 0.3;

export const TIDE_FLOW_RULES = [
  { key: "start", adjust: 1, label: "動き出し（潮が動きはじめて速くなっていく）" },
  { key: "run", adjust: 0, label: "よく流れている（ピークを過ぎて緩んでいく）" },
  { key: "slack", adjust: -1, label: "潮止まり前後（ほとんど動いていない）" },
];

export const TIDE_FLOW_LABELS = Object.fromEntries(
  TIDE_FLOW_RULES.map((r) => [r.key, r.label.replace(/（.*$/, "")]));

/**
 * 指定時刻に潮がどう動いているか。
 *
 * 速さは **その日いちばん速い流れを 1 とした割合**で測る。cm/h の絶対値で
 * 線を引くと、小潮の日は一日じゅう「潮止まり」になってしまい、
 * 潮回り（すでにスコアに入っている）を二重に減点することになるため。
 *
 * @returns {{key:string, ratio:number, cmPerHour:number, direction:string}|null}
 */
export function tideFlowAt(tide, hhmm) {
  const levels = tide?.hourly_levels_cm;
  const at = hoursFromHhmm(hhmm);
  if (!levels?.length || at == null) return null;

  // 前後 30 分の差 = その時刻の流速（cm/h、符号つき）。毎時値の線形補間なので
  // これ以上細かく測っても精度は上がらない（tideAt と同じ考え方）
  const speedAt = (h) => {
    const clamp = (v) => Math.max(0, Math.min(23, v));
    const before = tideLevelAt(levels, clamp(h - 0.5));
    const after = tideLevelAt(levels, clamp(h + 0.5));
    return before == null || after == null ? null : after - before;
  };

  const speed = speedAt(Math.min(at, 23));
  if (speed == null) return null;

  let fastest = 0;
  for (let h = 0; h <= 23; h++) {
    const s = speedAt(h);
    if (s != null) fastest = Math.max(fastest, Math.abs(s));
  }
  const ratio = fastest > 0 ? Math.abs(speed) / fastest : 0;

  const next = speedAt(Math.min(at + 1, 23));
  const speedingUp = next != null && Math.abs(next) > Math.abs(speed);

  return {
    key: ratio < SLACK_RATIO ? "slack" : speedingUp ? "start" : "run",
    ratio, cmPerHour: speed,
    direction: Math.abs(speed) < 1 ? "潮止まり" : speed > 0 ? "上げ潮" : "下げ潮",
  };
}

/**
 * その日の釣行スコア。朝マヅメ・夕マヅメをそれぞれ判定し、良いほうを日のスコアにする。
 * 潮回りは日単位なので、朝と夕で差が出るのは天気・風と潮の動きだけ。
 * 日の出・日没が取れない日（予報範囲外など）は 12 時で代表させる。
 *
 * @param {{tideType:string, hours:object[], sun:object|null, tide:object|null}} input
 * @returns {{score:number, best:object, windows:object[], tideType:string, fallback:boolean}|null}
 */
export function fishingScoreOfDay({ tideType, hours, sun, tide = null }) {
  const evaluate = (label, at, row) => {
    if (!row) return null;
    const detail = fishingScoreDetail(tideType, row.weather_code, row.wind_speed_ms);
    const flow = tideFlowAt(tide, at);
    // 雷雨・雨・強風は潮より優先する。荒れている日を潮の動きで持ち上げない
    const weatherGate = detail.ruleIndex <= 1;
    const rule = flow && !weatherGate
      ? TIDE_FLOW_RULES.find((r) => r.key === flow.key) : null;
    const adjust = rule?.adjust ?? 0;
    return {
      label, at, hour: row.hour,
      weatherCode: row.weather_code, windMs: row.wind_speed_ms,
      ...detail,
      base: detail.score, flow, adjust, weatherGate,
      score: Math.min(5, Math.max(1, detail.score + adjust)),
    };
  };

  const windows = mazumeWindows(sun)
    .map((w) => evaluate(w.label, w.at, hourNearest(hours, w.at)))
    .filter(Boolean);

  if (windows.length) {
    const best = windows.reduce((a, b) => (b.score > a.score ? b : a));
    return { score: best.score, best, windows, tideType, fallback: false };
  }

  // 日の出・日没が無いときの逃げ道。基準がある方が「出ない」よりましなので残す
  const noon = evaluate("昼", "12:00", hours?.find((h) => h.hour === 12) ?? hours?.[0]);
  if (!noon) return null;
  return { score: noon.score, best: noon, windows: [noon], tideType, fallback: true };
}

export function stars(score) {
  return `${"★".repeat(score)}${"☆".repeat(5 - score)}`;
}

/**
 * 釣行スコアの説明を出す。「どういう式か」だけでなく
 * 「この日はなぜこの点になったか」を先に示す（式だけでは自分の日に当てはめられない）。
 * @param {ReturnType<typeof fishingScoreOfDay>} day
 */
export function showFishingScoreHelp(day) {
  if (!day) return null;
  const { score, best, windows, tideType, fallback } = day;

  const flowText = (w) => {
    if (w.weatherGate) return "潮は見ない（荒天が優先）";
    if (!w.flow) return "潮位データなし";
    return `${w.flow.direction} ${TIDE_FLOW_LABELS[w.flow.key]}`
      + (w.adjust ? ` ${w.adjust > 0 ? "＋" : "−"}${Math.abs(w.adjust)}` : " ±0");
  };

  const windowRow = (w) => `
    <li class="${w === best ? "hit" : ""}">
      <span class="rule-star">${stars(w.score)}</span>
      <span class="mz-body">
        <span class="mz-name">${escapeHtml(w.label)}<span class="mz-time">${escapeHtml(w.at)}</span></span>
        <span class="mz-wx">${escapeHtml(describeWeather(w.weatherCode).label)}
          / ${w.wind.toFixed(1)}m/s ・ ${escapeHtml(flowText(w))}</span>
      </span>
    </li>`;

  const signed = (n) => (n > 0 ? `＋${n}` : n < 0 ? `−${Math.abs(n)}` : "±0");

  return showInfoDialog("釣行スコア", `
    <div class="score-head">
      <span class="score-stars">${stars(score)}</span>
      <span class="score-num-sm">${score} / 5</span>
    </div>
    <div class="rows" style="margin-bottom:14px">
      <div class="row"><span class="label">潮回り</span>
        <span class="val">${escapeHtml(tideType ?? "—")}</span></div>
    </div>

    <div class="list-sub" style="margin-bottom:6px">${fallback
      ? "日の出・日没が取れないので 12 時で見ています"
      : "マヅメごとの判定（良いほうがその日のスコア）"}</div>
    <ol class="score-rules mazume">${windows.map(windowRow).join("")}</ol>

    <div class="list-sub" style="margin:12px 0 6px">${escapeHtml(best.label)}の内訳</div>
    <div class="rows">
      <div class="row"><span class="label">天候・潮回りから</span>
        <span class="val">${best.base}</span></div>
      <div class="row"><span class="label">潮の動き</span>
        <span class="val">${signed(best.adjust)}</span></div>
      <div class="row"><span class="label">釣行スコア</span>
        <span class="val">${score}</span></div>
    </div>

    <div class="list-sub" style="margin:12px 0 6px">天候・潮回りの判定（上から順に当てはめる）</div>
    <ol class="score-rules">
      ${FISHING_SCORE_RULES.map((rule, i) => `
        <li class="${i === best.ruleIndex ? "hit" : ""}">
          <span class="rule-star">${stars(rule.score)}</span>
          <span>${escapeHtml(rule.label)}</span>
        </li>`).join("")}
    </ol>

    <div class="list-sub" style="margin:12px 0 6px">潮の動きによる加減点</div>
    <ol class="score-rules">
      ${TIDE_FLOW_RULES.map((rule) => `
        <li class="${!best.weatherGate && best.flow?.key === rule.key ? "hit" : ""}">
          <span class="rule-adjust">${signed(rule.adjust)}</span>
          <span>${escapeHtml(rule.label)}</span>
        </li>`).join("")}
    </ol>

    <div class="list-sub" style="margin-top:12px;line-height:1.6">
      天気と風は${fallback ? "" : "日の出・日没に"}いちばん近い時刻の予報を代表値にしています。
      潮回りは月齢からの計算で、1 日を通して同じです。
      潮の速さは<strong>その日いちばん速い流れとの比</strong>で見ているので、
      小潮の日でも「動いている／止まっている」を区別できます。
      雷雨・雨・強風の日は潮の動きで持ち上げません。
      目安であり、釣れることを保証するものではありません。
    </div>`);
}

/** 共通の説明ダイアログ。Esc・背景タップ・×ボタンで閉じる。 */
export function showInfoDialog(title, html) {
  document.getElementById("info-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "info-dialog";
  dialog.className = "info-dialog";
  dialog.innerHTML = `
    <div class="info-dialog-head">
      <h2>${escapeHtml(title)}</h2>
      <button type="button" class="close" aria-label="閉じる">${icon("close", { size: 18 })}</button>
    </div>
    <div class="info-dialog-body">${html}</div>`;
  document.body.appendChild(dialog);

  dialog.querySelector(".close").addEventListener("click", () => dialog.close());
  // 背景（dialog 自身の余白）を押したときだけ閉じる
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  return dialog;
}

/* ---------------- データアクセス ---------------- */

/**
 * ログイン中のユーザー ID。
 * getUser() は毎回 /auth/v1/user を叩くため、レート制限や通信エラーで null を返し
 * 得る。null のまま INSERT すると RLS 違反（=「権限がありません」）になって
 * 原因が分からなくなるので、ネットワークに出ない getSession() から取る。
 * （getSession() はアクセストークンが期限切れなら自動で更新する）
 */
export async function currentUserId() {
  const { data } = await client.auth.getSession();
  return data.session?.user?.id ?? null;
}

/**
 * 書き込み前のユーザー ID 取得。取れないときは RLS 違反にせず、
 * 何をすればよいか分かる日本語のエラーにする。
 */
export async function requireUserId() {
  const id = await currentUserId();
  if (!id) throw new Error("セッションが切れました。お手数ですが再度ログインしてください。");
  return id;
}

/**
 * スポット一覧。自分のもの＋同じグループの人のもの（D-065）。
 * 各行に `is_mine` と `owner_name` が付く。編集できるのは自分のものだけで、
 * それは画面の作りではなく `spots` の RLS が担保している。
 * 自分のものを先に並べる（ホームの基準スポットは自分の釣り場であってほしい）。
 */
export async function listSpots() {
  const { data, error } = await client
    .from("spot_feed")
    .select("*")
    .order("is_mine", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/** 1 件だけ取る。共有されたスポットも開ける。 */
export async function getSpot(id) {
  const { data, error } = await client
    .from("spot_feed").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * 釣果一覧。読み取りは record_feed ビューから行う（010）。
 * 自分の釣果 + 同じグループの人の公開釣果が、投稿者名つきで返る。
 * 書き込みは fishing_records へ直接行う（他人の行は RLS が拒否する）。
 */
export async function listRecords({ limit = 50, spotId = null } = {}) {
  let query = client
    .from("record_feed")
    .select("*")
    .order("fished_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (spotId) query = query.eq("spot_id", spotId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * 誰の釣果かを示すタグ（D-064）。自分のものにも付ける。
 * 色はカラシ（自分）と青（ほかの人）。カラシはこのアプリで
 * 「自分のもの」を指す色（スコアの円・ナビの選択中）なので、意味が揃う。
 */
export function ownerBadge(record) {
  return record?.is_mine
    ? `<span class="owner-badge mine">自分</span>`
    : `<span class="owner-badge">${escapeHtml(record?.owner_name ?? "メンバー")}</span>`;
}

/**
 * 一覧に出す魚の名前。出世魚の呼称があればそれを、なければ魚種名を使う。
 * 呼称ルールを持たない魚種（アジ・カサゴなど）でも名前が出るようにする。
 * record_feed（fish_label）と fishing_records（埋め込み）の両方の形に対応する。
 */
export function recordFishName(record) {
  return record.fish_label ?? record.fish_name_local ?? record.fish_species?.name ?? "釣果";
}

/* ---------------- 釣果写真（D-045） ----------------
   原本は保存しない。表示用のコピーだけを持つ（原本はカメラロールにある）。
   ブラウザ側で縮小してから上げるので、無料枠 1GB でも実用上まず埋まらない。 */

export const PHOTO_BUCKET = "catch-photos";
const PHOTO_MAX_EDGE = 1600;      // 表示用。スマホの画面ならこれで十分
const PHOTO_THUMB_EDGE = 400;     // 一覧用
const PHOTO_MAX_COUNT = 4;        // 1 つの釣果につき
export { PHOTO_MAX_COUNT };

// 画質ではなく **容量** を目標にする。
// 端末によって使える形式が違い（iOS Safari は canvas から WebP を書き出せず
// JPEG に落ちる）、同じ品質値でも 1.5 倍ほど差が出る。実測: 同じ 1600px で
// WebP 484KB に対し JPEG 756KB。品質を固定すると容量が読めないので、
// 予算内に収まる品質を上から順に試す。
const PHOTO_BUDGET_BYTES = 420 * 1024;
const PHOTO_THUMB_BUDGET_BYTES = 40 * 1024;
const PHOTO_QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5];

/**
 * 画像を縮小して WebP にする。
 * - EXIF は canvas を通した時点で落ちる（位置情報が写真から漏れない）
 * - 向きは imageOrientation で補正する。指定しないと横倒しになる端末がある
 */
export async function shrinkImage(file, options = {}) {
  const source = await loadImage(file);
  try {
    return renderImage(source, options);
  } finally {
    source.close?.();
  }
}

/**
 * 読み込み済みの画像から 1 枚作る。
 * **デコード結果を使い回すために分けてある**（D-061）。表示用とサムネイルで
 * 2 回デコードすると、大きな写真では山になるメモリが 2 倍になり、
 * 端末によっては途中で落ちる。
 */
async function renderImage(source, { maxEdge = PHOTO_MAX_EDGE, budget = PHOTO_BUDGET_BYTES } = {}) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);

  // 予算に収まった時点で止める。収まらなければ最後（一番小さい）を使う
  let blob = null;
  for (const quality of PHOTO_QUALITY_STEPS) {
    // WebP が使えない環境では JPEG に落とす（バケット側も両方許可している）
    blob = await canvasToBlob(canvas, "image/webp", quality)
      ?? await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob) break;
    if (blob.size <= budget) break;
  }
  // 縮小した canvas から書き出せないのは、ほぼ端末のメモリ不足
  if (!blob) throw new Error("画像を変換できませんでした。端末の空き容量を空けて、もう一度お試しください。");
  return { blob, width, height, type: blob.type };
}

/**
 * 画像を 1 回だけデコードする。手前から順に試す（D-061）。
 *   1. そのまま     … 通常はこれで通る
 *   2. 縮小しながら … 巨大な写真はここで救う。原寸のビットマップを作らずに済む
 *   3. <img> 経由   … createImageBitmap が受け付けない形式の保険
 */
async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch { /* 次の手を試す */ }

  try {
    // 幅だけ指定すれば高さは比率で決まる。画素数が減るぶんメモリの山が低くなる
    return await createImageBitmap(file, {
      imageOrientation: "from-image", resizeWidth: PHOTO_MAX_EDGE, resizeQuality: "high",
    });
  } catch { /* 次の手を試す */ }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      // HEIC は Android のブラウザが開けない。何をすればいいかまで書く
      reject(new Error(
        `この画像は開けませんでした（${file.type || "形式不明"}）。`
        + "HEIC で撮影している場合は、カメラの設定を JPEG にするか、"
        + "写真アプリで JPEG に変換してからお試しください。"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality);
  });
}

/** 釣果に写真を 1 枚追加する（表示用とサムネイルの 2 つを上げる）。 */
export async function uploadRecordPhoto(recordId, file, sortOrder = 0) {
  const userId = await requireUserId();

  // デコードは 1 回だけ。以前は表示用とサムネイルで同じ写真を 2 回、
  // しかも同時にデコードしていて、大きな写真ではメモリの山が 2 倍になっていた（D-061）
  const source = await loadImage(file);
  let full, thumb;
  try {
    full = await renderImage(source);
    thumb = await renderImage(source, {
      maxEdge: PHOTO_THUMB_EDGE, budget: PHOTO_THUMB_BUDGET_BYTES,
    });
  } finally {
    source.close?.();
  }

  const extension = full.type === "image/webp" ? "webp" : "jpg";
  const photoId = crypto.randomUUID();
  const path = `${userId}/${photoId}.${extension}`;
  const thumbPath = `${userId}/${photoId}_t.${extension}`;

  const storage = client.storage.from(PHOTO_BUCKET);
  const options = { contentType: full.type, cacheControl: "31536000", upsert: false };
  const uploaded = await storage.upload(path, full.blob, options);
  if (uploaded.error) throw uploaded.error;
  const uploadedThumb = await storage.upload(thumbPath, thumb.blob,
    { ...options, contentType: thumb.type });
  if (uploadedThumb.error) {
    await storage.remove([path]).catch(() => {});
    throw uploadedThumb.error;
  }

  const { data, error } = await client.from("record_photos")
    .insert({
      record_id: recordId, user_id: userId, path, thumb_path: thumbPath,
      width: full.width, height: full.height, bytes: full.blob.size,
      sort_order: sortOrder,
    })
    .select().single();
  if (error) {
    // 台帳に載らなかった実体は誰からも辿れないので、必ず消す
    await storage.remove([path, thumbPath]).catch(() => {});
    throw error;
  }
  return data;
}

export async function listRecordPhotos(recordId) {
  const { data, error } = await client
    .from("record_photos")
    .select("*")
    .eq("record_id", recordId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data;
}

/** 台帳と実体の両方を消す。実体を先に消し、成功したら台帳を消す。 */
export async function deleteRecordPhotos(photos) {
  if (!photos.length) return;
  const paths = photos.flatMap((p) => [p.path, p.thumb_path]);
  const { error } = await client.storage.from(PHOTO_BUCKET).remove(paths);
  if (error) throw error;
  const removed = await client.from("record_photos")
    .delete().in("id", photos.map((p) => p.id));
  if (removed.error) throw removed.error;
}

/**
 * 非公開バケットなので、表示には署名付き URL が要る。
 * 発行時に RLS が効くので、見えない写真の URL は作れない。
 */
export async function signedPhotoUrls(paths, expiresIn = 3600) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await client.storage
    .from(PHOTO_BUCKET).createSignedUrls(unique, expiresIn);
  if (error) return new Map();
  return new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

/* ---------------- グループ（招待制の共有） ---------------- */

/**
 * 管理者かどうか。グループの作成と招待の発行はこの人だけができる（012）。
 * 画面の出し分け用で、実際の制限は RLS とトリガーが持つ。
 */
export async function isAppAdmin() {
  const { data, error } = await client.rpc("is_app_admin");
  if (error) return false;
  return data === true;
}

/** 自分が属するグループ。無ければ null。 */
export async function myGroup() {
  const { data, error } = await client
    .from("groups")
    .select("id, name, owner_id, created_at")
    .order("created_at")
    .limit(1);
  if (error) throw error;
  return data[0] ?? null;
}

/** グループのメンバー（表示名つき）。 */
export async function listGroupMembers(groupId) {
  const { data, error } = await client
    .from("group_member_names")
    .select("*")
    .eq("group_id", groupId)
    .order("joined_at");
  if (error) throw error;
  return data;
}

export async function createGroup(name) {
  const userId = await requireUserId();
  const { data, error } = await client
    .from("groups")
    .insert({ name, owner_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** 未使用・期限内の招待だけを返す。 */
/**
 * グループの招待リンク。**使用済みも含めて**返す（D-059）。
 * 3 本送ったうち誰が使ったかが分からないと、催促のしようがない。
 * 期限切れは出しても打つ手がないので除く。
 */
export async function listInvites(groupId) {
  const { data, error } = await client
    .from("group_invites")
    .select("token, label, expires_at, created_at, used_at")
    .eq("group_id", groupId)
    .or(`used_at.not.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * 招待リンクを作る。**1 本で 1 人だけ**登録できる（使い切り）。
 * 何人か招待するときは人数ぶんまとめて作る（D-059）。
 * メモを付けて 2 本以上作るときは「たろう 1」「たろう 2」と番号を振って区別できるようにする。
 * @param {number} count 作る本数
 */
export async function createInvite(groupId, label, count = 1) {
  const userId = await requireUserId();
  const n = Math.max(1, Math.min(Number(count) || 1, GROUP_MEMBER_LIMIT));
  const name = (label ?? "").trim();
  const rows = Array.from({ length: n }, (_, i) => ({
    group_id: groupId, created_by: userId,
    label: name ? (n > 1 ? `${name} ${i + 1}` : name) : null,
  }));
  const { data, error } = await client
    .from("group_invites").insert(rows).select("token, label, expires_at");
  if (error) throw error;
  return data;
}

/** グループの人数上限（010 の group_member_limit() と同じ値）。 */
export const GROUP_MEMBER_LIMIT = 8;

export async function revokeInvite(token) {
  const { error } = await client.from("group_invites").delete().eq("token", token);
  if (error) throw error;
}

export async function leaveGroup(groupId) {
  const userId = await requireUserId();
  const { error } = await client
    .from("group_members").delete()
    .eq("group_id", groupId).eq("user_id", userId);
  if (error) throw error;
}

/** 招待リンク。GitHub Pages でもローカルでも、今いる場所を基準に組み立てる。 */
export function inviteUrl(token) {
  return new URL(`signup.html?invite=${token}`, location.href).href;
}

/** 招待 API（Edge Function）。招待される人はまだアカウントが無いので認証しない。 */
export async function checkInvite(token) {
  const url = `${config.supabaseUrl}/functions/v1/invite?token=${encodeURIComponent(token)}`;
  const response = await fetchWithTimeout(url);
  return response.json();
}

export async function signUpWithInvite({ token, email, password, username }) {
  const response = await fetchWithTimeout(`${config.supabaseUrl}/functions/v1/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, email, password, username }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "登録に失敗しました。");
  return result;
}

/** 魚種の水域区分の表示順（確定仕様書 1.1 章の分類に合わせる）。 */
export const FISH_CATEGORY_ORDER = ["海水", "汽水", "淡水"];

/**
 * 魚種一覧。水域区分（海水 → 汽水 → 淡水）ごとにまとめ、
 * 区分内は sort_order で近縁種が隣接する順に並べる。
 * ユーザーが自分で追加した魚種は各区分の末尾（名前順）。
 */
export async function listSpecies() {
  const { data, error } = await client
    .from("fish_species")
    .select("id, name, category, name_rule_group, sort_order, user_id")
    .order("name");
  if (error) throw error;

  const rank = (category) => {
    const i = FISH_CATEGORY_ORDER.indexOf(category);
    return i === -1 ? FISH_CATEGORY_ORDER.length : i;   // 区分未設定は末尾
  };
  return data.slice().sort((a, b) =>
    rank(a.category) - rank(b.category)
    || (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, "ja"));
}

/** 魚種を水域区分ごとにグループ化する（[区分, 魚種配列] の配列）。 */
export function groupSpeciesByCategory(species) {
  const groups = new Map();
  for (const item of species) {
    const key = item.category ?? "その他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()];
}

export async function listRecipes() {
  const { data, error } = await client
    .from("lure_recipes")
    .select("id, name, category_large, category_small, color, weight_g, is_favorite")
    .order("is_favorite", { ascending: false })
    .order("name");
  if (error) throw error;
  return data;
}

/** 出世魚の呼称提案（設計補完書 5 章・RPC）。 */
export async function suggestFishName(speciesId, sizeCm) {
  const { data, error } = await client.rpc("suggest_fish_name", {
    p_fish_species_id: speciesId,
    p_size_cm: sizeCm,
  });
  if (error) throw error;
  return data;
}

export async function tideCorrelation() {
  const { data, error } = await client
    .from("tide_correlation")
    .select("*")
    .order("score", { ascending: false });
  if (error) throw error;
  return data;
}

/* ---------------- 画面共通 ---------------- */

/** ボトムナビを描画する。current は home / tide / map / records / recipes。
    設定はここに置かない（毎日開く場所ではないため、ホームのヘッダーから開く）。 */
export function renderNav(current) {
  const items = [
    ["home", "index.html", "home", "ホーム"],
    ["tide", "tide.html", "tide", "潮汐"],
    ["map", "spots.html", "map", "マップ"],
    ["records", "records.html", "records", "釣果"],
    ["recipes", "recipes.html", "recipes", "レシピ"],
  ];
  document.body.insertAdjacentHTML("beforeend", `
    <nav class="bottom-nav">
      ${items.map(([key, href, iconName, label]) => `
        <a class="nav-item${key === current ? " active" : ""}" href="${href}">
          ${icon(iconName, { size: 21, className: "nav-icon" })}<span>${label}</span>
        </a>`).join("")}
    </nav>`);
  renderIcons();
}

/** data-icon 属性を持つ要素にアイコンを描画する。 */
export function renderIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (el.dataset.iconDone) return;
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 18 }));
    el.dataset.iconDone = "1";
  });
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ---------------- タックル（D-066） ---------------- */

export const TACKLE_KINDS = [
  { kind: "rod", label: "ロッド" },
  { kind: "reel", label: "リール" },
  { kind: "line", label: "ライン" },
  { kind: "leader", label: "リーダー" },
];

/** 自分のタックル。種別 → 名前の配列。 */
export async function listTackle() {
  const { data, error } = await client
    .from("tackle_items").select("kind, name").order("name");
  if (error) throw error;
  const byKind = Object.fromEntries(TACKLE_KINDS.map((k) => [k.kind, []]));
  for (const row of data) byKind[row.kind]?.push(row.name);
  return byKind;
}

export async function addTackle(kind, name) {
  const userId = await requireUserId();
  const { data, error } = await client
    .from("tackle_items")
    .insert({ user_id: userId, kind, name: name.trim() })
    .select("id, kind, name").single();
  if (error) throw error;
  return data;
}

export async function removeTackle(kind, name) {
  const { error } = await client
    .from("tackle_items").delete().eq("kind", kind).eq("name", name);
  if (error) throw error;
}

/* ---------------- ルアーカテゴリ（確定仕様書 2.1・9.1 章） ---------------- */

export const LURE_CATEGORIES = [
  { value: "area",  label: "エリア", subs: ["スプーン", "クランク（エリア）", "プラグ（エリア）"] },
  { value: "hard",  label: "ハード", subs: ["ミノー", "シンペン", "ポッパー", "ペンシル", "バイブ", "クランク", "シャッド", "スイムベイト"] },
  { value: "metal", label: "メタル", subs: ["ジグ", "ジグヘッド", "スピンテール", "メタルバイブ"] },
  { value: "soft",  label: "ソフト", subs: ["ワーム", "グラブ", "シャッドテール", "チューブ"] },
  { value: "egi",   label: "エギ",   subs: ["エギ", "タコエギ"] },
  { value: "other", label: "その他", subs: ["その他"] },
];

/** 釣果に残したルアー種別の表示（「ハード / ミノー」）。無ければ null。 */
export function lureCategoryText(record) {
  const large = record?.lure_category_large;
  if (!large) return null;
  const label = categoryLabel(large);
  const small = record.lure_category_small;
  return small && small !== label ? `${label} / ${small}` : label;
}

export function categoryLabel(value) {
  return LURE_CATEGORIES.find((c) => c.value === value)?.label ?? "";
}

/** 大カテゴリごとのタグ色（一覧カードの種別バッジ用）。 */
export function categoryTagClass(value) {
  return { area: "tag-green", hard: "tag-blue", metal: "tag-mustard", egi: "tag-purple" }[value]
    ?? "tag-gray";
}

/* ---------------- メーカー・タグ・レシピ ---------------- */

export async function listMakers() {
  const { data, error } = await client.from("makers").select("id, name").order("name");
  if (error) throw error;
  return data;
}

export async function listTags() {
  const { data, error } = await client.from("tags").select("id, name").order("name");
  if (error) throw error;
  return data;
}

/** レシピ一覧（メーカー名・タグ付き）。 */
export async function listRecipesDetailed() {
  const { data, error } = await client
    .from("lure_recipes")
    .select("*, makers(id, name), recipe_tags(tag_id, tags(id, name))")
    .order("is_favorite", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({ ...r, tags: (r.recipe_tags ?? []).map((rt) => rt.tags).filter(Boolean) }));
}

/** レシピごとの釣果件数（実績スコア）。 */
export async function recipeCatchCounts() {
  const { data, error } = await client
    .from("fishing_records")
    .select("recipe_id")
    .not("recipe_id", "is", null);
  if (error) throw error;
  const counts = {};
  for (const row of data) counts[row.recipe_id] = (counts[row.recipe_id] ?? 0) + 1;
  return counts;
}

export async function toggleFavorite(recipeId, isFavorite) {
  const { error } = await client
    .from("lure_recipes")
    .update({ is_favorite: isFavorite })
    .eq("id", recipeId);
  if (error) throw error;
}

/** レシピのタグ紐付けを与えられた集合に合わせる。 */
export async function setRecipeTags(recipeId, tagIds) {
  const { error: deleteError } = await client
    .from("recipe_tags").delete().eq("recipe_id", recipeId);
  if (deleteError) throw deleteError;
  if (!tagIds.length) return;
  const { error } = await client
    .from("recipe_tags")
    .insert(tagIds.map((tagId) => ({ recipe_id: recipeId, tag_id: tagId })));
  if (error) throw error;
}

/* ---------------- スポット（設計補完書 4 章） ---------------- */

/**
 * スポット種別（015）。並びは 海 → 汽水 → 淡水。
 * 分ける基準は「釣り方が変わるかどうか」。地形が違っても狙い方が同じなら分けない
 * （堤防は港湾と実質同じなので「港湾・堤防」にまとめている）。
 */
export const SPOT_TYPES = [
  // 海
  { value: "surf",          label: "サーフ",     color: "#4A9ECC", iconName: "surf" },
  { value: "cobble",        label: "ゴロタ場",   color: "#7E9AAE", iconName: "cobble" },
  { value: "rock",          label: "磯",         color: "#4CAF50", iconName: "rock" },
  { value: "port",          label: "港湾・堤防", color: "#C9A84C", iconName: "port" },
  { value: "tetra",         label: "テトラ帯",   color: "#9AA5B1", iconName: "tetra" },
  // 汽水
  { value: "rivermouth",    label: "河口",       color: "#2A9D8F", iconName: "rivermouth" },
  { value: "tidalflat",     label: "干潟",       color: "#B08968", iconName: "tidalflat" },
  { value: "brackish_lake", label: "汽水湖",     color: "#4A9ECC", iconName: "lake" },
  { value: "channel",       label: "水路・運河", color: "#6E9ECF", iconName: "channel" },
  // 淡水
  { value: "river",         label: "河川",       color: "#6E9ECF", iconName: "river" },
  { value: "lake",          label: "湖沼・池",   color: "#5C8AA8", iconName: "lake" },
  { value: "managed",       label: "管理釣り場", color: "#4CAF50", iconName: "managed" },
];

export const WATER_TYPES = [
  { value: "saltwater",  label: "海水" },
  { value: "brackish",   label: "汽水" },
  { value: "freshwater", label: "淡水" },
];

export function spotType(value) {
  return SPOT_TYPES.find((t) => t.value === value)
    ?? { value: null, label: "未設定", color: "#9AA5B1", iconName: "map-pin" };
}

export function waterLabel(value) {
  return WATER_TYPES.find((w) => w.value === value)?.label ?? "—";
}

/** Google マップで開く URL（端末にアプリがあればアプリが起動する）。 */
export function googleMapsUrl(spot) {
  return `https://www.google.com/maps/search/?api=1&query=${spot.latitude},${spot.longitude}`;
}

/** Google マップの経路案内 URL。 */
export function googleDirectionsUrl(spot) {
  return `https://www.google.com/maps/dir/?api=1&destination=${spot.latitude},${spot.longitude}`;
}

/* ---------------- 地図（Leaflet + 地理院タイル・D-026） ---------------- */

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

/** 夜間モード（地図を暗く表示）の設定。端末内にのみ保存する。 */
export function isNightMap() {
  return localStorage.getItem("tidebase.nightMap") === "1";
}

export function setNightMap(on) {
  localStorage.setItem("tidebase.nightMap", on ? "1" : "0");
  document.querySelectorAll(".leaflet-container").forEach((el) => {
    el.classList.toggle("night-map", on);
  });
}

/** スポットが 1 件もないときの地図の初期表示（静岡県特化・浜名湖〜遠州灘）。 */
export const DEFAULT_MAP_CENTER = [34.7100, 137.6000];
export const DEFAULT_MAP_ZOOM = 11;

/** 地図を生成する。tiles: "pale"（淡色・既定）/ "photo"（航空写真）。 */
/**
 * 地図を作る。
 * @param {object} options
 * @param {boolean} options.lock ページの中に埋め込む地図は true。
 *   指を置いた場所が地図だと、そのままページを縦にスクロールできなくなるため、
 *   最初は地図の操作を止めて「タップして地図を操作」の覆いを出す。
 *   タップした時点で操作を有効にする（Google マップの埋め込みと同じ考え方）。
 *   マップ画面のように地図そのものが主役の画面では false。
 */
export function createMap(element, {
  center = DEFAULT_MAP_CENTER, zoom = DEFAULT_MAP_ZOOM, lock = false,
} = {}) {
  const map = L.map(element, {
    center, zoom, zoomControl: true, attributionControl: true,
    // ホイールでのズームは、ページを流し読みしている最中に暴発するので常に切る
    scrollWheelZoom: false,
    dragging: !lock, touchZoom: !lock, doubleClickZoom: !lock,
  });
  if (isNightMap()) map.getContainer().classList.add("night-map");
  const layers = {
    pale: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: GSI_ATTRIBUTION, className: "tile-pale",
    }),
    photo: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
      maxZoom: 18, attribution: GSI_ATTRIBUTION,
    }),
  };
  layers.pale.addTo(map);
  if (lock) addMapUnlock(map);
  return { map, layers, current: "pale" };
}

/** 「タップして地図を操作」の覆い。押されたら操作を有効にして消える。 */
function addMapUnlock(map) {
  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "map-unlock";
  cover.innerHTML = `<span>${icon("locate", { size: 15 })} タップして地図を操作</span>`;
  cover.addEventListener("click", () => {
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    cover.remove();
  }, { once: true });
  map.getContainer().appendChild(cover);
}

/** スポット種別の色を反映した HTML マーカー（外部画像に依存しない）。 */
export function spotMarker(spot, { label = true } = {}) {
  const type = spotType(spot.spot_type);
  const warn = spot.low_tide_only
    ? `<span class="pin-warn">${icon("warning", { size: 13 })}</span>` : "";
  const name = label && spot.name
    ? `<span class="pin-label">${escapeHtml(spot.name)}</span>` : "";
  return L.divIcon({
    className: "spot-pin-wrap",
    html: `<span class="spot-pin" style="--pin:${type.color}">`
        + `${icon(type.iconName, { size: 14 })}${warn}</span>${name}`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}
