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
    navigate("login.html", { replace: true });
    return null;
  }
  return data.session;
}

/** ログイン済みなら遷移先へ送る（ログイン・登録画面用）。 */
export async function redirectIfSignedIn(destination = "index.html") {
  const { data } = await client.auth.getSession();
  if (data.session) navigate(destination, { replace: true });
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

/* 曜日は**英語の 3 文字**（D-113）。週間カレンダーが前からこれで、
   等幅で幅が揃うので一覧の列が縦にそろう（「水」と「日」は全角で見た目の重さも違う）。
   画面の見出しもすべて英語なので、そちらとも揃う。
   **この配列はここにしか置かない。** 前は日本語版が app.js に 2 つ、
   news.html と tide.html にもあり、コピーが 4 つに増えていた。 */
export const WEEKDAYS_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * 日付の表記（D-113）。**画面に出す日付はすべてここを通す。**
 *
 * `2026.08.12 WED` / 今年なら `08.12 WED`。
 * 前は区切りが `.` と `/`、曜日が `水` `(水)` `WED` `無し` の 4 通り、
 * 0 埋めも不揃いで、15 か所が思い思いの形だった。
 * **組み立てるコードが 4 か所にべた書きされていたのが原因。**
 *
 * @param {string} isoDate "YYYY-MM-DD"（後ろに時刻が付いていてもよい）
 * @param {boolean} weekday 曜日を付けるか。**「その日に何をするか」に関わる所だけ付ける**
 *   （釣行日・予報の日・お知らせ）。招待の有効期限のような事務的な日付には付けない。
 * @param {boolean|"auto"} year 年を出すか。"auto" は**今年なら省く**。
 *   普段は短く、年をまたいだ記録だけ長くなる。
 */
export function formatJstDate(isoDate, { weekday = false, year = "auto" } = {}) {
  const [y, m, d] = String(isoDate ?? "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  const pad = (v) => String(v).padStart(2, "0");
  const showYear = year === "auto" ? y !== Number(todayInJst().slice(0, 4)) : Boolean(year);
  const label = `${showYear ? `${y}.` : ""}${pad(m)}.${pad(d)}`;
  if (!weekday) return label;
  return `${label} ${WEEKDAYS_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
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

/* 取りに行った潮汐を、この画面が開いているあいだ覚えておく（D-140）。

   **観測所と日付が決まれば中身は変わらない**ので、同じものを 2 度取る意味が無い。
   実際、ホームは毎回 08-26 と 08-27 を 2 回ずつ取っていた。時差のある地点は
   fetchTideForPoint が前後の日もつなぐため、3 日ぶん描くと日付が重なる。

   **約束（Promise）のまま入れる。** 結果が返ってから入れると、
   ほぼ同時に投げた 2 本目が「まだ入っていない」を見て走り出す。
   失敗したものは覚えない（一度の不通が画面を開いているあいだ残ってしまう）。 */
const tideRequests = new Map();

export async function fetchTide(station, date) {
  const key = `${station}|${date}`;
  const known = tideRequests.get(key);
  if (known) return known;

  const url = `${config.supabaseUrl}/functions/v1/tide`
    + `?station=${encodeURIComponent(station)}&date=${encodeURIComponent(date)}`;
  const pending = (async () => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`潮汐データを取得できませんでした (${response.status})`);
    return response.json();
  })();
  tideRequests.set(key, pending);
  pending.catch(() => tideRequests.delete(key));
  return pending;
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


/**
 * 複数日を 1 本につないだ潮位グラフの SVG を返す。
 * @param {object} options
 * @param {string[]} options.days      連続した日付（昇順）
 * @param {object[]} options.tides     days と同じ並びの潮汐（未取得は null）
 * @param {Map<string,object>} options.suns 日付 → {rise, set}
 * @param {string} options.today       今日の日付（帯で示す。D-119）
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
    /* 日付は**上の帯**に出す（D-120）。ここには時刻だけを置く。
       D-057 で日付を下に降ろしたのは「満 15:32」とぶつかったからだが、
       いまは帯をいちばん上（満潮の印より上）に置くので、ぶつからない。
       下は時刻だけになり、そのぶん読みやすくなった（本人の指摘）。 */
    for (const h of [6, 12, 18]) {
      marks.push(`<text x="${x(d * 24 + h) + 3}" y="${height - 10}">${h}:00</text>`);
    }
    return marks;
  }).join("");

  /* 日付の帯（D-119 / D-120 / D-121）。**SVG の外に、HTML で出す。**

     SVG のテキストは `position: sticky` にできない。中に置くと、
     日の頭が画面の外へ出た時点で日付も消える（1 画面 = 1 日なので、
     少し送っただけでそうなる）。**時間別天気の日付の帯とまったく同じ作り**
     （`.day-seg` の中の `.day-name` を sticky にする）にして、
     いま見ている日の日付が画面の中に残るようにする。

     幅の計算は要らない。帯は潮位グラフと同じ器（`.tide-track`）に入れ、
     1 日 1 枠を `flex: 1` で等分するので、**グラフとずれようがない**。 */
  const ruler = `<div class="tide-days">${days.map((date) =>
    `<span class="day-seg${date === today ? " today" : ""}"
       ><span class="day-name">${escapeHtml(formatJstDate(date, { weekday: true }))}</span></span>`
  ).join("")}</div>`;

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
  return { svg, ruler, min, max, sunMarks, levelTicks };
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
  let query = client.from("tide_stations")
    .select("code, name, lat, lng, pref, spring_flow_cm_h").order("lng");
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
/* 潮位表地点は**年に一度も変わらない**のに、ホーム・潮汐・マップ・スポット詳細の
   4 画面が毎回 2 クエリ（3.5KB）取り直していた（D-126）。
   Service Worker は REST をネットワーク優先にしているので、必ず通信が起きる。
   バイト数より **1 往復（シンガポールまで 60〜70ms）が惜しい**。

   端末に持たせ、**配信の版が変われば捨てる**。地点が増減したときは
   その配信で拾えるので、別の失効の仕組みを持たなくてよい。 */
const TIDE_POINT_CACHE_PREFIX = "tidebase.tidePoints.";

function cachedTidePoints(key) {
  try {
    const raw = localStorage.getItem(TIDE_POINT_CACHE_PREFIX + key);
    if (!raw) return null;
    const points = JSON.parse(raw);
    return Array.isArray(points) && points.length ? points : null;
  } catch {
    return null;                 // 壊れていたら取り直す
  }
}

function rememberTidePoints(key, points) {
  if (!points?.length) return;   // 取れなかったものを覚えない
  try {
    // 古い版のぶんは残しておく意味が無いので、この接頭辞のものは消してから入れる
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(TIDE_POINT_CACHE_PREFIX)) localStorage.removeItem(k);
    }
    localStorage.setItem(TIDE_POINT_CACHE_PREFIX + key, JSON.stringify(points));
  } catch {
    /* 容量いっぱいなら、覚えないだけでよい */
  }
}

export async function listTidePoints({ pref = "静岡県" } = {}) {
  const cacheKey = `${APP_VERSION}.${pref}`;
  const remembered = cachedTidePoints(cacheKey);
  if (remembered) return remembered;

  const [stations, areas] = await Promise.all([
    listTideStations({ pref }).catch(() => []),
    listTideAreas({ pref }).catch(() => []),
  ]);
  const stationName = new Map(stations.map((s) => [s.code, s.name]));
  const springByStation = new Map(stations.map((s) =>
    [s.code, s.spring_flow_cm_h == null ? null : Number(s.spring_flow_cm_h)]));
  const points = [
    ...stations.map((s) => ({
      value: `ST:${s.code}`, group: "潮位表地点（気象庁）", label: s.name, name: s.name,
      station: s.code, area: null, lagMinutes: 0, levelRatio: 1,
      lat: Number(s.lat), lng: Number(s.lng),
      // 大潮の最大流速（D-135）。無い観測所では潮の強さの条件を対象外にする
      springFlow: s.spring_flow_cm_h == null ? null : Number(s.spring_flow_cm_h),
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
      // 細分地点は基準観測点の値を使う（潮高比は springFlowRatio の中で掛ける）
      springFlow: springByStation.get(a.base_station_code) ?? null,
      baseName: stationName.get(a.base_station_code) ?? a.base_station_code,
      note: a.note, source: a.source,
    })),
  ];
  rememberTidePoints(cacheKey, points);
  return points;
}

/** 時差を「+2:00」の形で表す。 */
export function formatLag(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** localStorage に保存した潮汐地点の選択。**D-105 で役目を終えた**。
    残っている値は「前は地点を選べた」ことの知らせを出すためだけに読む。 */
export function savedTidePoint() {
  return localStorage.getItem("tidebase.tidePoint");
}
export function saveTidePoint(value) {
  if (value) localStorage.setItem("tidebase.tidePoint", value);
  else localStorage.removeItem("tidebase.tidePoint");
}

/* ---------------- 基準スポット（D-105） ----------------
   **選ぶものはスポット 1 つ。** そのスポットが
   「天気を取る座標」と「潮汐の観測所」の両方を決める。

   前は「潮汐地点」を選び、天気は別に自動選択したスポットの座標で取っていた。
   おかげでホームの 1 行に 3 つの出所が混ざり（スポット名 / 別地点の潮回り /
   スポットの天気）、先頭のピンが全部を同じ場所のことに見せていた。
   さらにホームはスポット座標・潮汐詳細は地点座標だったので、
   **同じ日でも 2 画面で違う天気**が出ていた。 */

/* 前回どこを見ていたかを、地点まで含めて覚えておく（D-140）。

   ホームは「スポット一覧 → 潮位表地点 → 潮汐と天気」の 3 段で待っていた。
   前の 2 段は**どの地点を見るか**を決めるためだけにあり、
   ふだんは前回と同じところを見る。なら**先に投げておける。**

   覚えたものが当たっていれば 3 段が 2 段になり、外れていても
   fetchTide / fetchWeather が同じものを 2 度取らないので損はしない。
   スポットの座標や観測所を変えたときは、次に開いたときに覚え直される。 */
const LAST_VIEW_KEY = "tidebase.lastView";

export function rememberedView(spotId) {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // 別のスポットを選んでいたら使わない（先に投げても無駄になる）
    return saved && saved.spotId === (spotId ?? null) ? saved : null;
  } catch {
    return null;
  }
}

export function rememberView(spotId, point, weatherAt) {
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({
      spotId: spotId ?? null, point: point ?? null, weatherAt: weatherAt ?? null,
    }));
  } catch {
    /* 容量いっぱいなら、覚えないだけでよい */
  }
}

/** 覚えていた地点と、実際に決まった地点が同じか。違えば取り直す。 */
export function sameView(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function savedBaseSpot() {
  return localStorage.getItem("tidebase.baseSpot");
}
export function saveBaseSpot(id) {
  if (id) localStorage.setItem("tidebase.baseSpot", id);
  else localStorage.removeItem("tidebase.baseSpot");
}

/**
 * 基準スポットを決める。ホームと潮汐詳細で同じ規則を使う（別々にすると
 * 「ホームは福田港なのに潮汐画面は網干場」が起きる）。
 *
 * @param {object[]} spots listSpots() の結果（is_mine 降順・作成が新しい順）
 * @param {string|null} savedId 端末に保存した選択
 * @returns {object|null} 1 件も無ければ null
 */
export function pickBaseSpot(spots, savedId = null) {
  const list = spots ?? [];
  // 保存した選択がいちばん強い。ただし消されたスポットは無視する
  const saved = savedId ? list.find((s) => s.id === savedId) : null;
  if (saved) return saved;
  // 淡水（管理釣り場・湖沼）は潮汐が無いので、海か汽水を先に選ぶ。
  // どれも淡水なら先頭（＝いちばん新しい）を使う
  const pick = (rows) => rows.find((s) => s.water_type !== "freshwater") ?? rows[0] ?? null;
  const mine = list.filter((s) => s.is_mine);
  return pick(mine) ?? pick(list);
}

/**
 * スポットに対応する潮汐地点の**オブジェクト**を返す（D-105）。
 * 淡水スポットは観測所を持たないので null。
 * @param {object|null} spot
 * @param {object[]} points listTidePoints() の結果
 */
export function spotTidePoint(spot, points) {
  const value = tidePointOfSpot(spot);
  if (!value) return null;
  return (points ?? []).find((p) => p.value === value) ?? null;
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
    /* **満干の潮位も潮高比で縮める**（D-133）。時刻だけずらして潮位をそのままに
       すると、曲線は縮んでいるのに満干の点だけ元の高さに残り、**点がグラフから浮く**。
       潮高比が全地点 1.00 だった間は現れなかった。036 で実際の比を入れて表に出た */
    high_tides: shiftEvents(base.high_tides, point.lagMinutes, mean, point.levelRatio),
    low_tides: shiftEvents(base.low_tides, point.lagMinutes, mean, point.levelRatio),
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
/**
 * 満干の時刻を時差ぶんずらし、潮位を潮高比で縮める。
 * **縮め方は毎時値と同じ（日内平均のまわり）**でなければ、点が曲線から外れる。
 */
function shiftEvents(events, lagMinutes, mean = 0, levelRatio = 1) {
  return (events ?? []).flatMap((e) => {
    if (!e.time) return [];
    const [h, m] = e.time.split(":").map(Number);
    const total = h * 60 + m + lagMinutes;
    if (total < 0 || total >= 24 * 60) return [];   // 前日・翌日に出るぶんは表示しない
    return [{
      ...e,
      time: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
      level_cm: e.level_cm == null ? null
        : Math.round(mean + (e.level_cm - mean) * levelRatio),
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

/** 天気の名前だけ。**アイコンを描かない**ので、SVG を持たない場所からも呼べる。 */
export function weatherLabel(code) {
  return (WMO[code] ?? ["—"])[0];
}

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

/* ---------------- 天気の参照先（D-076） ----------------
   Open-Meteo 経由で **気象庁の数値予報（MSM 5km メッシュ / 39 時間以降は GSM）** を使う。
   日本の海沿いを見るなら、全球モデル（GFS・ICON・ECMWF）より格子が細かく、
   何より国内の予報の元になっているものと同じ。

   既定（best_match）でも、この地点では気象庁と同じ値が返ってくることを確かめた
   （GFS・ICON・ECMWF とは明らかに違う値になる）。それでも**名指しする**のは、
   選び方が向こうの都合で変わっても、こちらの表示が黙って変わらないようにするため。

   ただし名指しは「その日その時に気象庁のデータが無ければ何も出ない」を意味する。
   取れなかったときは既定に戻して取り直す。天気が出ないより、
   別モデルでも出たほうがいい。 */
/* 出典は**実際に出している値のとおり**に書く（D-111）。
   気象庁のモデルは突風を返さない（48 時間ぶん頼んで 0 件）ので、
   そこだけ別のモデル（best_match ＝ この地点では ECMWF）で埋めている。
   「気象庁」とだけ書いていたのは嘘だった。 */
export const WEATHER_SOURCE = "気象庁 MSM/GSM（突風のみ ECMWF）・Open-Meteo 経由";

/* **突風は気象庁のモデルから返ってこない**（D-104 / D-111）。
   models=jma_seamless で頼むと全時間 null になる（48 時間ぶんで 0 件）。
   降水確率も同じだったが、そちらは出すのをやめた（D-111）。
   既定（best_match）なら 48/48 揃い、しかも共通の項目（気温・風速・天気）は
   気象庁と同じ値だった（この地点では best_match が気象庁を選んでいる）。

   そこで **2 つのモデルを 1 回のリクエストでまとめて頼む**。
   Open-Meteo は models を並べると `weather_code_jma_seamless` のように
   接尾辞つきで両方返す。値は気象庁を先に見て、無いところだけ既定で埋める。
   往復は 1 回のままで、D-076 の「名指しする」意図も保てる。 */
const WEATHER_MODELS = "jma_seamless,best_match";
const WEATHER_MODEL_ORDER = ["jma_seamless", "best_match"];
const WEATHER_HOURLY =
  "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl";
/* 1 時間ごとの予報を読むとき用（D-104 / D-111）。
   突風は「キャストできるか」に効くので、平均風速だけでは足りない。

   **降水確率は頼まない**（D-111）。気象庁は降水確率を返さないので、
   出していた 85% は ECMWF の値だった。画面には「出典: 気象庁」と書いてあり、
   ウェザーニュース（気象庁ベース）の 40% と食い違う原因になっていた。
   しかもモデル間の開きが大きく（同じ時刻で ICON 0% / GFS 25% / ECMWF 85%）、
   数字として当てにならない。**気象庁の予想雨量（mm）で語る。** */
const WEATHER_HOURLY_DETAIL =
  `${WEATHER_HOURLY},precipitation,wind_gusts_10m`;

/** 気象庁のモデルを名指しして取る。だめなら既定（best_match）で取り直す。 */
async function fetchForecast(query) {
  const url = `https://api.open-meteo.com/v1/forecast?${query}`;
  const pinned = await fetchWithTimeout(`${url}&models=${WEATHER_MODELS}`).catch(() => null);
  if (pinned && pinned.ok) return pinned;
  return await fetchWithTimeout(url);
}

/**
 * 指定座標・指定日の 1 時間刻み予報と、その日の日の出・日没。
 * 波高は海上グリッド外だと null になる（設計補完書 1.1 章）。
 * @returns {{hours: object[], sun: {rise: string, set: string}|null}}
 *          sun の時刻は "HH:MM"（JST）。極夜・白夜では null になり得る。
 */
/* 潮汐と同じ理由で、取りに行った予報も覚えておく（D-140）。
   こちらは**時間とともに変わる**ので、覚えるのは画面が開いているあいだだけ。
   先に投げておいた分（rememberedPoint）と本来の分が同じ地点・同じ日なら、
   ここで 1 本にまとまる。 */
const weatherRequests = new Map();

export async function fetchWeather(lat, lng, date) {
  const key = `${Number(lat).toFixed(4)}|${Number(lng).toFixed(4)}|${date}`;
  const known = weatherRequests.get(key);
  if (known) return known;
  const pending = fetchWeatherUncached(lat, lng, date);
  weatherRequests.set(key, pending);
  pending.catch(() => weatherRequests.delete(key));
  return pending;
}

async function fetchWeatherUncached(lat, lng, date) {
  // 「0 時から 24 時間後まで」を満たすため翌日 0 時まで取得する（確定仕様書 2.2 章）
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const base = `latitude=${lat}&longitude=${lng}&timezone=Asia%2FTokyo`
    + `&start_date=${date}&end_date=${nextDay}`;
  const marineUrl = "https://marine-api.open-meteo.com/v1/marine?" + base + "&hourly=wave_height";

  const [forecastRes, marineRes] = await Promise.all([
    // 1 地点ぶんなので、予想雨量と突風まで取る（D-104 / D-111）
    fetchForecast(`${base}&hourly=${WEATHER_HOURLY_DETAIL}&wind_speed_unit=ms`),
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
/**
 * 予報の 1 項目を取り出す（D-104）。
 *
 * models を並べて頼むと `weather_code_jma_seamless` のように接尾辞が付く。
 * **1 時間ずつ、先のモデルから見て最初に値があるものを採る。**
 * 気象庁のモデルは突風が全部 null なので、そこだけ既定（best_match）で埋まる。
 * 接尾辞なし（1 モデルだけ頼んだとき）はそのまま返す。
 */
export function forecastSeries(hourly, name, models = WEATHER_MODEL_ORDER) {
  if (Array.isArray(hourly?.[name])) return hourly[name];
  const candidates = models
    .map((m) => hourly?.[`${name}_${m}`])
    .filter((series) => Array.isArray(series));
  if (!candidates.length) return null;
  return candidates[0].map((_, i) => {
    for (const series of candidates) if (series[i] != null) return series[i];
    return null;
  });
}

/* Open-Meteo の 1 時間値は**項目によって意味が違う**（D-111）。
   - 気温・風速・風向は **その時刻の瞬間値**（`minutely_15` と 24/24 一致した）
   - 雨量・天気記号・突風は **その時刻までの 1 時間**（雨の降った時間だけで
     15 分値の合計と突き合わせて、気象庁 22:1・ICON 4:1。天気記号は雨の
     あるなしが切り替わる 4 か所で 4:0。ICON は 15 分値を自前で持つので循環しない）

   ここを読み違えて「17:00 の値」を「17 時台の値」として出していた。
   16 時台に降って 17 時前に上がった雨を、17:09 に見て
   **「いま雨が降っています」**と書いていたのがこれ（本人の指摘で発覚）。

   **「H 時のカード」は H:00〜H+1:00 のこと**に統一する。そのために、
   区間の値だけ 1 つ後ろからとる。最後の 1 時間は次が無いので落とす。 */
function mapHourly(h, waves = null) {
  const at = (name) => forecastSeries(h, name) ?? [];
  const temp = at("temperature_2m"), code = at("weather_code");
  const wind = at("wind_speed_10m"), dir = at("wind_direction_10m");
  const mm = at("precipitation"), gust = at("wind_gusts_10m");
  const pressure = at("pressure_msl");
  const rows = h.time.map((time, i) => {
    const next = i + 1;      // 区間の値はこちらを見る
    return {
      time,
      hour: Number(time.slice(11, 13)),
      // 瞬間値。その時刻ちょうどの値
      temp_c: temp[i] ?? null,
      wind_speed_ms: wind[i] ?? null,
      wind_dir_deg: dir[i] ?? null,
      pressure_hpa: pressure[i] ?? null,
      /* **3 時間前との差**（D-135）。気象で気圧変化量に使う定番の窓。
         「高気圧から低気圧に変わるとき活性が高い」を点に入れるのに要る。
         窓の先頭 3 時間は前が無いので null。**無いことと 0 は別物**なので分ける */
      pressure_trend_hpa: pressure[i] != null && pressure[i - 3] != null
        ? Math.round((pressure[i] - pressure[i - 3]) * 10) / 10
        : null,
      // 区間の値。この時刻から 1 時間ぶん
      // 頼まなかった項目は入らない。無いことと 0 は別物なので null のままにする
      weather_code: code[next] ?? null,
      precip_mm: mm[next] ?? null,
      wind_gust_ms: gust[next] ?? null,
      wave_height_m: waves ? waves[i] : null,
    };
  });
  // 最後の 1 時間は区間の値が空になる。中途半端な行を残すより落とす
  return rows.length > 1 ? rows.slice(0, -1) : rows;
}

/**
 * **複数地点**の当日ぶんの時間別予報を 1 リクエストでまとめて取る（D-077）。
 * スポットごとにスコアを出すのに使う。地点ごとに叩くとスポットの数だけ往復する。
 *
 * Open-Meteo は latitude / longitude をカンマ区切りで並べると、
 * 地点ごとの配列を返してくる（実際に 3 地点で確かめた）。
 *
 * 注意: MSM の格子は約 5km なので、**近いスポットどうしは同じ格子に落ちる**。
 * 浜名湖の中の 2 か所で天気に差は出ない。差が出るのは離れた場所どうし。
 *
 * @param {Array<{lat:number, lng:number}>} points
 * @returns {Promise<Array<object[]|null>>} points と同じ並びの時間別予報
 */
export async function fetchWeatherMulti(points, date) {
  if (!points.length) return [];
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const query = `latitude=${points.map((p) => p.lat).join(",")}`
    + `&longitude=${points.map((p) => p.lng).join(",")}`
    + `&timezone=Asia%2FTokyo&start_date=${date}&end_date=${nextDay}`
    + `&hourly=${WEATHER_HOURLY}&wind_speed_unit=ms`;

  let body;
  try {
    const response = await fetchForecast(query);
    if (!response.ok) return points.map(() => null);
    body = await response.json();
  } catch {
    return points.map(() => null);   // 天気が出なくても一覧は出す
  }
  // 1 地点だけのときは配列ではなくオブジェクトで返ってくる
  const list = Array.isArray(body) ? body : [body];
  return points.map((_, i) => (list[i]?.hourly?.time ? mapHourly(list[i].hourly) : null));
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
  /* 予想雨量と突風まで取る（D-105 / D-111）。潮汐詳細の時間別天気がここを使うので、
     WEATHER_HOURLY だけだと「雨が降るか」がまた出せなくなる。
     8 日 × 24 時間 × 7 項目 × 2 モデルで 30KB ほど。週に 1 回なので許容する */
  const query = `latitude=${lat}&longitude=${lng}&timezone=Asia%2FTokyo`
    + `&start_date=${startDate}&end_date=${last}`
    + `&hourly=${WEATHER_HOURLY_DETAIL}&wind_speed_unit=ms`;

  const result = new Map();
  let forecast;
  try {
    const response = await fetchForecast(query);
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

  /* **頼まれた最終日の翌日も返す**（D-114）。0 時を足すためだけに取った日だが、
     捨てていたせいで「週の最終日の夜」に時間別天気が数枚で途切れていた。
     土曜の 21 時に開くと、翌日ぶんが手元に無く 4 枚しか出ない。
     この日は 23 時間ぶんしかない（最後の 1 時間は区間の値が無いので落ちる）が、
     23 時に開いても翌日 22 時まで並ぶので 24 枚には足りる。
     使う側は endDate までを週として扱い、翌日は「はみ出しぶん」として見ること。 */
  for (const [date, hours] of byDate) {
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

/* 釣行スコアの決め方（D-135。D-018 / D-050 の規則表を取り消す）。

   **2 段になっている。**
     ① 荒天のゲート … 雷雨・強風・雨は、それだけで点が決まる（★1・★2）
     ② 良い条件の数 … それ以外の日は、揃った条件の割合で ★3〜★5

   以前は「大潮 + 晴れ + 風 5m/s 以下 → ★5」のような組み合わせ表だった。
   実データ 112 日で測ると **97% の日が ★4 か ★5** になり、
   日を選ぶ材料になっていなかった。原因は、大潮と中潮で 1 か月の 2/3 を占め、
   そこに晴れが重なると上限に張り付くこと。

   **潮回りのラベルは使わない**（本人の指摘）。
   「大潮が釣れやすい」は、砕くと「潮がよく流れるから」で、それは他の潮回りでも
   起きる。実測でも中潮の上位は大潮の下位を上回る（舞阪の最大流速: 大潮 23〜31、
   中潮 15〜28 cm/h）。ラベルではなく**実際の流速**を見る。 */

/* ---- 釣りにならない条件（D-139） --------------------------------------

   **点を付けずに止める。**「条件が悪い」ではなく「そもそも行けない」。
   だから**狭く、めったに立たない**ものだけを置く。
   以前はここに「雨・雪、または風速 10m/s 超 → ★2」があり、
   全 2688 時間の **24% がこれで ★2** になっていた。しかも weather_code 51
   （霧雨）も雨に含まれるので、本人が実際に釣った 20 件のうち **7 件**が
   「霧雨・風速 1.0〜4.8m/s」で ★2 と判定されていた。魚が釣れている時間を
   「釣りにならない」と言っていたことになる。雨は下の係数へ移した。 */

/** これ以上は投げられない風速（m/s）。 */
export const BLOCK_WIND_MS = 15;

export const SCORE_BLOCKS = [
  { key: "storm", label: "雷", match: (weather) => weather === "storm" },
  { key: "gale", label: `風速 ${BLOCK_WIND_MS}m/s 以上`,
    match: (_weather, wind) => wind >= BLOCK_WIND_MS },
];

/* ---- 係数（D-139） ----------------------------------------------------

   **すべて 1.0 が「ふつう」。0 は使わない。**
   幾何平均は対数の平均なので、0 が 1 つ入ると全体が 0 になる。
   「釣りにならない」は上の SCORE_BLOCKS が受け持つ。 */

/**
 * 折れ線の内挿。表の外側は端の値で頭打ちにする。
 * 材料が無ければ null（呼ぶ側が 1.0 として分母に残す）。
 *
 * **`Number(x)` だけで判定しない。** `Number(null)` も `Number("")` も 0 なので、
 * 材料が無いのに「x = 0」として表の左端（風なら 0.85）を返してしまう。
 * 気圧のように 0 が正常値の表もあるので、null と 0 は必ず分ける。
 */
export function curveAt(points, x) {
  if (x == null || x === "") return null;
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  if (v <= points[0][0]) return points[0][1];
  if (v >= points.at(-1)[0]) return points.at(-1)[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (v <= x1) return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
  }
  return null;
}

/** 潮の速さ。**その地点でいちばん速く流れるときに対する比**（D-135）。 */
export const FLOW_CURVE = [[0, 0.65], [0.3, 0.85], [0.6, 1.15], [0.8, 1.32], [1.0, 1.38]];
/** 風（m/s）。2〜4 が山。無風だと水面が動かず、強すぎると投げられない（本人の体感）。 */
export const WIND_CURVE = [[0, 0.85], [1.5, 1.05], [3, 1.20], [5, 1.15],
                           [8, 1.00], [10, 0.85], [15, 0.65]];
/** 気圧の変化（hPa / 3 時間）。下がっているほど上がる。 */
export const PRESSURE_CURVE = [[-3, 1.25], [-1, 1.12], [0, 1.00], [1, 0.90], [3, 0.80]];
/** 潮の勢いの向き。動き出しは少し上げ、潮止まり前後は少し下げる。 */
export const FLOW_PHASE_FACTORS = { start: 1.08, run: 1.00, slack: 0.92 };
/** 雨。**霧雨は下げない。** 強い雨だけ少し引く（weather_code）。 */
export const RAIN_FACTORS = { 65: 0.85, 75: 0.85, 82: 0.85, 63: 0.95, 73: 0.95, 81: 0.95 };

/**
 * 掛け合わせる係数（D-139）。**この表がそのままモーダルの一覧になる。**
 *
 * **見られないものは分母から外す。** 潮汐の効かない場所の潮も、
 * 材料が取れなかった係数も、同じ扱いにする（D-135 の applicable と同じ）。
 *
 * 一度「材料が無いものは 1.0 で分母に残す（情報が欠けているのだから
 * 中央に寄るのが正しい）」と考えたが、**測ったら間違いだった。**
 * 日の点は 24 時間の最大値なので、1.0 を混ぜてばらつきを縮めると
 * **最大値そのものが下がる**。基準を持たない観測所で日の★が
 * ★1 20% / ★2 44% / ★3 37% / ★4 0% に潰れた（分母から外せば
 * ★1 5% / ★2 21% / ★3 74%）。中央に寄るのではなく、低い側に寄っていた。
 */
export const SCORE_FACTORS = [
  {
    key: "flow", tide: true, label: "潮の流れ",
    detail: "ここでいちばん速く流れるときに近いほど上がる。潮回りは見ていない",
    of: (c) => curveAt(FLOW_CURVE, c.flowRatio),
    /* 「上げ4分」だけにせず**判定に使った % を残す**（D-138）。 */
    describe: (c) => (c.flowRatio == null ? null
      : `${c.phase ? `${c.phase.label} ` : ""}${Math.round(c.flowRatio * 100)}%`),
  },
  {
    key: "start", tide: true, label: "潮の動き",
    detail: "動き出しは少し上げ、潮止まり前後は少し下げる",
    of: (c) => (c.flow?.key ? FLOW_PHASE_FACTORS[c.flow.key] ?? 1 : null),
    describe: (c) => (!c.flow ? null : TIDE_FLOW_LABELS[c.flow.key]),
  },
  {
    key: "wind", tide: false, label: "風",
    detail: "2〜4m/s が山。無風だと水面が動かず、強すぎると投げられない",
    of: (c) => curveAt(WIND_CURVE, c.wind),
    describe: (c) => (c.wind == null ? null : `${Number(c.wind).toFixed(1)}m/s`),
  },
  {
    key: "press", tide: false, label: "気圧",
    detail: "3 時間前より下がっていれば上がる。上がっていれば下げる",
    of: (c) => curveAt(PRESSURE_CURVE, c.pressureTrend),
    // 符号は半角で揃える。等幅で桁が並ぶので、＋だけ全角だと崩れる
    describe: (c) => (c.pressureTrend == null ? null
      : `${c.pressureTrend > 0 ? "+" : ""}${c.pressureTrend}hPa/3h`),
  },
  {
    key: "rain", tide: false, label: "雨",
    detail: "霧雨は下げない。強い雨のときだけ少し引く",
    of: (c) => RAIN_FACTORS[c.weatherCode] ?? 1,
    // アイコンまで作る describeWeather は使わない（SVG を持たない場所からも呼ぶ）
    describe: (c) => weatherLabel(c.weatherCode),
  },
];

/* ---- ★への割りふり（D-139） ------------------------------------------

   **実測の分布から取った。** 舞阪の 112 日ぶん（潮汐・気象とも実データ）を
   前半 61 日と後半 51 日に割り、**前半だけで線を引いて後半に当てた**。

     時間  前半 ★1 10 / ★2 20 / ★3 40 / ★4 20 / ★5 10 %
           後半 ★1  7 / ★2 21 / ★3 37 / ★4 23 / ★5 12 %
     日    前半 ★1 10 / ★2 21 / ★3 39 / ★4 20 / ★5 10 %
           後半 ★1 12 / ★2 12 / ★3 51 / ★4 18 / ★5  8 %

   季節をまたいでも崩れないので、**固定の数でよい**（期間ごとに引き直さない）。

   **日と時間で別の線を使う。** 日の点は 24 時間の最大値なので、
   必ず分布の上端に寄る。時間の線をそのまま使うと ★5 が 79% になった。 */
export const HOUR_CUTS = [0.918, 0.960, 1.031, 1.082];
export const DAY_CUTS = [1.051, 1.073, 1.123, 1.140];

/** 掛け合わせた値 → 1〜5。 */
export function starFromValue(value, cuts = HOUR_CUTS) {
  if (!Number.isFinite(value)) return 3;
  return value < cuts[0] ? 1 : value < cuts[1] ? 2
    : value < cuts[2] ? 3 : value < cuts[3] ? 4 : 5;
}

/**
 * 1 時間ぶんの判定。**画面の説明はこの戻り値をそのまま並べる**（D-050 の考え方は残す）。
 *
 * @param {object} c 判定の材料
 *   weatherCode / wind（m/s）/ flowRatio（その地点の最大流速に対する比）
 *   / flow（tideFlowAt の結果）/ phase（tidePhaseAt の結果）
 *   / pressureTrend（hPa/3h）/ tideMatters
 * @param {number[]} [cuts] ★に割りふる線。日の点では DAY_CUTS を渡す
 */
export function fishingScoreDetail(c, cuts = HOUR_CUTS) {
  const weather = weatherCategory(c.weatherCode);
  const wind = Number(c.wind) || 0;
  const tideMatters = c.tideMatters !== false;

  const block = SCORE_BLOCKS.find((b) => b.match(weather, wind)) ?? null;
  const factors = SCORE_FACTORS.map((f) => {
    const applicable = tideMatters || !f.tide;
    const raw = applicable ? f.of(c) : null;
    return {
      key: f.key, label: f.label, detail: f.detail,
      applicable,
      known: applicable && raw != null,
      factor: raw ?? 1,
      value: applicable ? f.describe(c) : null,
    };
  });

  const used = factors.filter((x) => x.known);
  /* 対数で足してから割る（幾何平均）。掛けてから累乗根を取ると、
     係数が増えたときに桁が小さくなって精度を落とす */
  const value = used.length
    ? Math.exp(used.reduce((s, x) => s + Math.log(x.factor), 0) / used.length)
    : 1;
  /* 釣りにならない時間も **★1 として並べる**。null を返すと、
     ★を比べている場所（週セル・時間別・いちばん良い時間帯）が全部
     null を扱う羽目になる。★1 は「いちばん悪い」なので意味も合う。
     「なぜ ★1 なのか」は block を見て画面が「釣行不可」と言う */
  const score = block ? 1 : starFromValue(value, cuts);
  return { score, value, block, factors, weather, wind, tideMatters };
}

export function fishingScore(input) {
  return fishingScoreDetail(input).score;
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

/* ---- 時間帯（D-102 / D-103） -------------------------------------------
   **釣行スコアと傾向の画面で同じ区切りを使う。** 別々に持つと、
   同じ 1 回の釣行が画面によって「夕マヅメ」だったり「夜」だったりする。 */

export const TIME_BANDS = [
  { key: "morning", label: "朝マヅメ" },
  { key: "day",     label: "日中" },
  { key: "evening", label: "夕マヅメ" },
  { key: "night",   label: "夜" },
];

export function timeBandLabel(key) {
  return TIME_BANDS.find((b) => b.key === key)?.label ?? null;
}

/**
 * その時刻がどの時間帯か。
 * 日の出・日没は呼ぶ側で計算して渡す（sunTimes）。ここを純粋にしておくと
 * 天文計算ぬきで境目を試せる。
 * @param {{rise:string,set:string}|null} sun
 * @param {string|null} hhmm  "HH:MM"（"HH:MM:SS" でも読む）
 * @returns {string|null} TIME_BANDS の key。時刻か日の出が無ければ null
 */
export function timeBandOf(sun, hhmm) {
  const at = hoursFromHhmm(hhmm);
  const rise = hoursFromHhmm(sun?.rise);
  const set = hoursFromHhmm(sun?.set);
  if (at == null || rise == null || set == null) return null;

  const width = MAZUME_WINDOW_MINUTES / 60;
  // マヅメを先に見る。日の出の直後は「日中」でもあるが、釣りとしてはマヅメ
  if (Math.abs(at - rise) <= width) return "morning";
  if (Math.abs(at - set) <= width) return "evening";
  return at > rise && at < set ? "day" : "night";
}

/**
 * 時間帯ごとに、点を出す候補になる予報の行を返す（D-103）。
 *
 * **マヅメと、日中・夜では選び方が違う。**
 * マヅメは日の出・日没という 1 点なので、いちばん近い 1 行を代表にする
 * （1 時間刻みの予報から代表を 1 つ選ぶ、という D-051 の考え方のまま）。
 * 日中と夜は数時間の幅があるので、その幅に入る行を全部渡し、
 * **いちばん条件の良い時刻**を呼ぶ側で選ぶ。「何時なら良いか」が要る場面なので、
 * 幅の平均をとって均してしまうと、行く時刻を決める役に立たない。
 *
 * @returns {Record<string, object[]>} 時間帯 key → 予報の行
 */
export function bandHours(hours, sun, date = null) {
  const rows = hoursOfDate(hours, date);
  const rise = hoursFromHhmm(sun?.rise);
  const set = hoursFromHhmm(sun?.set);
  if (!rows.length || rise == null || set == null) return {};

  const width = MAZUME_WINDOW_MINUTES / 60;
  const near = (target) => {
    const hit = rows.reduce((best, row) =>
      Math.abs(row.hour - target) < Math.abs(best.hour - target) ? row : best);
    return hit ? [hit] : [];
  };
  const between = (from, to) => rows.filter((r) => r.hour > from && r.hour < to);

  return {
    morning: near(rise),
    day: between(rise + width, set - width),
    evening: near(set),
    // 夜は日をまたぐが、**その日の夜**として夕方以降と未明の両方を入れる。
    // 傾向の画面（timeBandOf）と同じ切り方にしておく
    night: rows.filter((r) => r.hour > set + width || r.hour < rise - width),
  };
}

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

/**
 * その日ぶんの予報だけを取り出す（D-103）。
 *
 * **予報は 2 日ぶん取っている**（「0 時から 24 時間後まで」を満たすため）。
 * hour は 0〜23 の繰り返しなので、日付を見ずに「時」だけで近い行を探すと
 * **翌日の予報を静かに拾う**。いまは reduce が先勝ちなので当日に当たっているが、
 * 配列の作り方が変わった時点で崩れる。日付で絞ってから探す。
 */
export function hoursOfDate(hours, date) {
  if (!hours?.length) return [];
  if (!date) return hours;
  const sameDay = hours.filter((row) => String(row.time ?? "").startsWith(date));
  // 日付が入っていない形で渡されたときは、絞らずにそのまま返す（前の挙動）
  return sameDay.length ? sameDay : hours;
}

/** "HH:MM" にいちばん近い時刻の予報。date を渡すとその日のぶんから探す。 */
export function forecastHourAt(hours, hhmm, date = null) {
  return hourNearest(hours, hhmm, date);
}

function hourNearest(hours, hhmm, date = null) {
  const target = hoursFromHhmm(hhmm);
  const rows = hoursOfDate(hours, date);
  if (!rows.length || target == null) return null;
  return rows.reduce((best, row) =>
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

/* ---------------- 「いまの潮」（D-129） ----------------
   ホームで**いちばん知りたいのは、いま海がどう動いているか**。
   潮位グラフは読み取れば分かるが、読み取りが要る。
   ここは同じデータ（すでに取ってある潮汐と、計算で出る日の出日没）から
   文にして出すだけで、通信は増えない。 */

/** 残り時間を「2時間46分」の形にする。過ぎていれば null。 */
export function formatCountdown(minutes) {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return null;
  const m = Math.round(minutes);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}時間` : `${h}時間${rest}分`;
}

/**
 * 次に来る満潮または干潮。
 *
 * **翌日ぶんまで見る。** 夜釣りは日をまたぐので、22 時に開いて
 * 「今日はもう満潮が無い」で終わると、いちばん要る情報が消える。
 *
 * @param {object|null} today     その日の潮汐
 * @param {object|null} tomorrow  翌日の潮汐（無ければ null）
 * @param {string} hhmm           いまの時刻 "HH:MM"
 * @returns {{kind:"high"|"low", label:string, time:string, levelCm:number|null,
 *            inMinutes:number, nextDay:boolean}|null}
 */
export function nextTideEvent(today, tomorrow, hhmm) {
  const nowMin = minutesFromHhmm(hhmm);
  if (nowMin == null) return null;
  const events = [
    ...tideEvents(today, 0),
    ...tideEvents(tomorrow, 24 * 60),
  ].filter((e) => e.at > nowMin).sort((a, b) => a.at - b.at);
  const next = events[0];
  if (!next) return null;
  return {
    kind: next.kind,
    label: next.kind === "high" ? "満潮" : "干潮",
    time: next.time,
    levelCm: next.levelCm,
    inMinutes: next.at - nowMin,
    nextDay: next.at >= 24 * 60,
  };
}

function tideEvents(tide, offsetMin) {
  if (!tide) return [];
  return [
    ...(tide.high_tides ?? []).map((e) => ({ ...e, kind: "high" })),
    ...(tide.low_tides ?? []).map((e) => ({ ...e, kind: "low" })),
  ].flatMap((e) => {
    const at = minutesFromHhmm(e.time);
    return at == null ? [] : [{
      kind: e.kind, time: String(e.time).slice(0, 5),
      levelCm: e.level_cm ?? null, at: at + offsetMin,
    }];
  });
}

/**
 * 次に来る日の出か日没。**日没後は翌朝の日の出**を返す。
 * @param {{rise:string,set:string}|null} today
 * @param {{rise:string,set:string}|null} tomorrow
 * @param {string} hhmm
 * @returns {{kind:"rise"|"set", label:string, time:string, inMinutes:number,
 *            nextDay:boolean}|null}
 */
export function nextSunEvent(today, tomorrow, hhmm) {
  const nowMin = minutesFromHhmm(hhmm);
  if (nowMin == null) return null;
  const list = [
    { kind: "rise", label: "日の出", time: today?.rise, at: minutesFromHhmm(today?.rise) },
    { kind: "set", label: "日没", time: today?.set, at: minutesFromHhmm(today?.set) },
    { kind: "rise", label: "日の出", time: tomorrow?.rise,
      at: shiftMinutes(minutesFromHhmm(tomorrow?.rise), 24 * 60) },
  ].filter((e) => e.at != null && e.at > nowMin).sort((a, b) => a.at - b.at);
  const next = list[0];
  return next
    ? { kind: next.kind, label: next.label, time: String(next.time).slice(0, 5),
        inMinutes: next.at - nowMin, nextDay: next.at >= 24 * 60 }
    : null;
}

function shiftMinutes(value, offset) {
  return value == null ? null : value + offset;
}

function minutesFromHhmm(hhmm) {
  const hours = hoursFromHhmm(hhmm);
  return hours == null ? null : Math.round(hours * 60);
}

/**
 * 次の大潮がいつ始まって何日続くか（D-129）。
 *
 * 潮回りは月齢だけで決まる（tideType）ので、**通信もデータベースも要らない**。
 * 週間カレンダーは 1 週間しか映らないため、月末の大潮が視界の外にある。
 *
 * **大潮の長さは暦のとおりに返す。** 起点が大潮の途中でも、
 * 遡って本当の初日から数える。ここを「起点から先だけ」で数えると、
 * 4 日ある大潮の最終日を起点にしたときに「1 日間」と出て、
 * 読む人はその大潮を短いものだと受け取ってしまう。
 * 「あと何日あるか」は remaining のほうで別に返す。
 *
 * @param {string} fromIso        起点 "YYYY-MM-DD"（この日を含めて探す）
 * @param {(iso:string)=>string} typeOf  日付 → 潮回り（tideType を渡す）
 * @param {number} horizon        何日先まで探すか
 * @returns {{start:string, end:string, days:number, remaining:number,
 *            inDays:number, ongoing:boolean}|null}
 */
export function nextSpringTide(fromIso, typeOf, horizon = 45) {
  if (!fromIso || typeof typeOf !== "function") return null;
  let hit = null;
  for (let i = 0; i <= horizon; i++) {
    const iso = addJstDays(fromIso, i);
    if (typeOf(iso) === "大潮") { hit = { iso, inDays: i }; break; }
  }
  if (!hit) return null;

  // 本当の初日まで遡る。大潮は長くても数日なので、念のための上限だけ置く
  let back = 0;
  while (back < 10 && typeOf(addJstDays(hit.iso, -back - 1)) === "大潮") back++;
  const start = addJstDays(hit.iso, -back);

  let days = 0;
  while (days <= horizon && typeOf(addJstDays(start, days)) === "大潮") days++;
  return {
    start,
    end: addJstDays(start, days - 1),
    days,
    remaining: days - back,      // 起点を含めて、あと何日あるか
    inDays: hit.inDays,
    ongoing: hit.inDays === 0,
  };
}

/**
 * 「上げ 4 分」の形で、潮のどのあたりかを返す（D-138）。
 *
 * **N 分は潮位の絶対位置**（干潮を 0 分、満潮を 10 分とした 10 等分）。
 * 時間の割合ではない。下げ潮では数字が 10 → 0 と減っていくので、
 * 「上げ三分」と「下げ七分」はどちらも**転換から 3 割動いた点**を指す。
 * 釣りの言い回しでこの 2 つが対で語られるのはそのため。
 *
 * 実測（舞阪 112 日・上げ下げ 309 区間）では、区間の最大流速に対して
 * 転換直後の 1 割で 31% → 70% と一気に立ち上がり、3〜7 割の間は 85〜98% で
 * ほぼ平ら、最後の 1 割でまた一気に落ちる。**立ち上がりが急で真ん中は平ら**。
 *
 * 満干は毎時値から求める。**`tideFlowAt` と同じ系列から出す**ので、
 * 「上げ 4 分」と流速の判定が食い違わない。
 * high_tides / low_tides を使うと出どころが 2 つになって、ずれる目が出る。
 *
 * @param {object|null} tide その日の潮汐
 * @param {string} hhmm     "HH:MM"
 * @param {object} [around] 前後の日の潮汐。区間が日をまたぐときに要る
 * @returns {{tenth:number, rising:boolean, label:string}|null}
 */
export function tidePhaseAt(tide, hhmm, { previous = null, next = null } = {}) {
  const at = hoursFromHhmm(hhmm);
  const levels = tide?.hourly_levels_cm;
  if (at == null || !levels?.length) return null;

  // 前後の日をつないだ 72 時間の系列にする（区間は 6 時間ほどあり、日をまたぐ）
  const series = [
    ...(previous?.hourly_levels_cm ?? Array(24).fill(null)),
    ...levels,
    ...(next?.hourly_levels_cm ?? Array(24).fill(null)),
  ];
  /* **tideLevelAt は使えない。** あちらは 23 で頭打ちにする作りで、
     1 日ぶんの配列を前提にしている。ここは 72 時間つないでいるので、
     fetchTideForPoint と同じ interpolate を使う */
  const value = (h) => interpolate(series, h);
  const here = 24 + at;

  /* 前後の極値を探す。0.1 時間刻みで、傾きの向きが変わるところ。
     見つからない（材料が足りない）なら null を返して、呼び側は今までの表示に戻す */
  const STEP = 0.1;
  const slope = (h) => {
    const a = value(h - STEP), b = value(h + STEP);
    return a == null || b == null ? null : b - a;
  };
  const findEdge = (dir) => {
    const s0 = slope(here);
    if (s0 == null || s0 === 0) return null;
    for (let h = here + dir * STEP; h >= 0 && h <= 71.9; h += dir * STEP) {
      const s = slope(h);
      if (s == null) return null;
      if (s === 0 || (s > 0) !== (s0 > 0)) return { h, v: value(h) };
    }
    return null;
  };
  const back = findEdge(-1), forward = findEdge(+1);
  if (!back || !forward || back.v == null || forward.v == null) return null;

  const span = Math.abs(forward.v - back.v);
  if (span < 1) return null;                       // ほぼ平ら。分で言う意味がない
  const level = value(here);
  if (level == null) return null;

  const rising = forward.v > back.v;
  // 干潮を 0、満潮を 1 とした位置。上げでも下げでも同じ測り方
  const low = Math.min(back.v, forward.v);
  const fraction = Math.min(1, Math.max(0, (level - low) / span));
  const tenth = Math.round(fraction * 10);
  return { tenth, rising, label: `${rising ? "上げ" : "下げ"}${tenth}分` };
}

/**
 * 1 時間ぶんの点（D-115 で切り出した）。
 *
 * 「その日の時間帯」（fishingScoreOfDay）と「これから 24 時間の時間帯」
 * （fishingScoreAhead）の両方が、これを並べていちばん良い時刻を選ぶ。
 * **同じ式を 2 か所に書くと、片方だけ直して食い違う。**
 *
 * @param {object|null} input.row   予報の 1 行
 * @param {object|null} input.tide  その時刻の日の潮汐
 * @param {object|null} input.point 潮汐地点（大潮基準と潮高比を持つ）
 * @param {string|null} input.band  時間帯の key（マヅメ判定に使う）
 * @param {string} input.at         "HH:MM"。潮の動きを引く時刻
 */
function scoreHour({
  row, tide = null, point = null, tideMatters = true,
  label, at, key = null, band = null, around = undefined, cuts = HOUR_CUTS,
}) {
  if (!row) return null;
  const flow = tideMatters ? tideFlowAt(tide, at) : null;
  /* **時間帯（マヅメ）は点に渡さない**（D-139）。狙う魚と釣り方で
     良し悪しが逆になるので、アプリが一律に決めない。band は画面が使う */
  const detail = fishingScoreDetail({
    weatherCode: row.weather_code,
    wind: row.wind_speed_ms,
    flow,
    // 「上げ4分」（D-138）。説明にだけ使うので、取れなければ取れないでよい
    phase: tideMatters ? tidePhaseAt(tide, at, around ?? {}) : null,
    flowRatio: tideMatters ? springFlowRatio(flow, point) : null,
    pressureTrend: row.pressure_trend_hpa ?? null,
    tideMatters,
  }, cuts);
  return {
    key, label, at, hour: row.hour, band: band ?? key,
    weatherCode: row.weather_code, windMs: row.wind_speed_ms,
    pressureTrend: row.pressure_trend_hpa ?? null,
    flow, tide,
    ...detail,
  };
}

/**
 * いまの流速が、**その地点の大潮の最大流速の何割か**（D-135）。
 *
 * 絶対値（cm/h）で見ないのは、潮高比のわずかな誤差でスコアが大きく動くため
 * （潮高比 0.75 と 0.95 で条件の当たる時間が 11% と 22%・D-133）。
 * 比なら、分子の流速も分母の基準も同じ潮高比が掛かるので**約分される**。
 *
 * 基準を持っていない観測所では null を返す。呼び出し側で「対象外」にする。
 */
export function springFlowRatio(flow, point) {
  const base = Number(point?.springFlow);
  if (!flow || !Number.isFinite(base) || base <= 0) return null;
  const ratio = Number(point?.levelRatio);
  // 細分地点は潮高比ぶん小さく振れるので、基準も同じだけ小さくする
  const reference = base * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
  return Math.abs(flow.cmPerHour) / reference;
}

/**
 * 1 時間ごとの点を出す関数を作る（D-116）。
 *
 * ホームの★を「時間帯 4 つ」から**1 時間ごと**に変えたので、
 * 予報の 1 行から点を引く口が要る。**式は scoreHour のまま**（点の出し方は変えない）。
 * 潮汐も潮回りも日をまたぐので、**その行の日付で引く**。
 *
 * @param {(date:string)=>{tide?:object,tideType?:string}|null} contextOf
 * @returns {(row:object)=>number|null} 予報の 1 行 → 1〜5
 */
export function hourScorer({ contextOf, tideMatters = true, point = null }) {
  return (row) => {
    if (!row) return null;
    const date = String(row.time).slice(0, 10);
    const ctx = contextOf(date) ?? {};
    const at = `${String(row.hour).padStart(2, "0")}:00`;
    /* 時間帯は点に入らなくなった（D-139）ので、sun は要らない。
       それでも contextOf から受け取れる形は残す（画面が band を使う） */
    return scoreHour({
      row, tide: ctx.tide ?? null, point: ctx.point ?? point,
      tideMatters, label: null, at,
      band: timeBandOf(ctx.sun ?? null, at),
    })?.score ?? null;
  };
}

/**
 * その日の釣行スコア。**時間帯ごとに判定する**（朝マヅメ・日中・夕マヅメ・夜）。
 * 潮回りは日単位なので、時間帯で差が出るのは天気・風と潮の動きだけ。
 * 日の出・日没が取れない日（予報範囲外など）は 12 時で代表させる。
 *
 * **マヅメ 2 点だけを見ていたのをやめた**（D-103）。本人の釣行 17 件のうち
 * マヅメは 3 件で、残り 14 件は夜と日中だった。行く時間の点が出ていなかった。
 *
 * @param {object} input
 * @param {string} [input.date] 予報を当日ぶんに絞るための日付（"YYYY-MM-DD"）。
 *   渡さないと 2 日ぶんの配列から探すことになる（D-103 の hoursOfDate を見ること）。
 *
 * **日の点は、いつでも「その日いちばん良い時間帯」の点**（D-123）。
 * 「よく行く時間帯」で別の帯に固定できるようにしていたが、
 * 行く時間帯はその都度ちがう、という理由でやめた。
 * @returns {{score, best, windows, bands, tideType, fallback}|null}
 */
export function fishingScoreOfDay({
  tideType, hours, sun, tide = null, tideMatters = true, date = null, point = null,
}) {
  const evaluate = (label, at, row, key = null) =>
    scoreHour({ row, tide, point, tideMatters, label, at, key, band: key });

  /* **★ではなく掛け合わせた値で比べる**（D-139）。★は 5 段しかないので、
     同点だらけになって「何時がいちばん良いか」が最初の 1 件で決まってしまう。
     釣りにならない時間（雷・暴風）は、値が高くても代表にしない */
  const rank = (h) => (h.block ? -1 : h.value);
  const better = (a, b) => (rank(b) > rank(a) ? b : a);

  const candidates = bandHours(hours, sun, date);
  const windows = TIME_BANDS.map(({ key, label }) => {
    const rows = candidates[key] ?? [];
    if (!rows.length) return null;
    /* 幅のある時間帯（日中・夜）は **いちばん条件の良い時刻**を代表にする。
       平均をとると「何時に行けばいいか」が消える。何時なのかは at に入るので、
       画面には「夜 21時」のように出る。 */
    const scored = rows
      .map((row) => evaluate(label, `${String(row.hour).padStart(2, "0")}:00`, row, key))
      .filter(Boolean);
    // 初期値に null を置いて reduce すると、1 周目で a.score を読んで落ちる
    if (!scored.length) return null;
    return scored.reduce(better);
  }).filter(Boolean);

  if (windows.length) {
    // マヅメは日の出・日没そのものを時刻として見せる（1 時間刻みに丸めない）
    for (const w of windows) {
      if (w.key === "morning" && sun?.rise) w.at = sun.rise;
      if (w.key === "evening" && sun?.set) w.at = sun.set;
    }
    const best = windows.reduce(better);
    /* **日の★は日用の線で引く**（D-139）。日の点は 24 時間の最大値なので、
       時間の線をそのまま使うと必ず上端に寄る（実測で ★5 が 79%）。
       windows の中の score は時間の線のまま（あちらは実際に 1 時間だから） */
    return {
      score: best.block ? 1 : starFromValue(best.value, DAY_CUTS),
      value: best.value, block: best.block,
      best, top: best, windows, bands: windows,
      tideType, tideMatters, fallback: false,
    };
  }

  // 日の出・日没が無いときの逃げ道。基準がある方が「出ない」よりましなので残す
  const sameDay = hoursOfDate(hours, date);
  const noon = evaluate("昼", "12:00", sameDay.find((h) => h.hour === 12) ?? sameDay[0]);
  if (!noon) return null;
  return {
    score: noon.block ? 1 : starFromValue(noon.value, DAY_CUTS),
    value: noon.value, block: noon.block,
    best: noon, top: noon, windows: [noon], bands: [noon],
    tideType, tideMatters, fallback: true,
  };
}

/**
 * これから count 時間を、時間帯の**まとまり**に切る（D-115）。
 *
 * `bandHours` は「その日の帯」を返す。**夜はその日の未明と夕方以降の両方**が入る
 * （過去の釣行を分類する `timeBandOf` に合わせてある・D-102）。
 * これを「これから」に使うと壊れる。10 時に見たとき夜の代表が今日の 02 時になり、
 * **まだ来ていない今夜が「過ぎた時間帯」として消える**（本人の指摘で発覚）。
 *
 * ここでは時刻の順に見て、**同じ帯が続くあいだを 1 つのまとまり**にする。
 * 日をまたぐ夜は 1 つになり、明日の朝マヅメは別のまとまりになる。
 * 代表時刻ではなく「まとまりに時間が残っているか」で決まるので、
 * 過ぎた帯はそもそも出てこない。
 *
 * @param {object[]} hours 予報（2 日ぶん）
 * @param {string} nowIso "YYYY-MM-DDTHH:MM"（JST）
 * @param {(date:string)=>{rise:string,set:string}|null} sunOf 日付ごとの日の出・日没
 * @returns {{key:string,label:string,date:string,rows:object[]}[]}
 */
export function bandRunsAhead(hours, nowIso, sunOf, count = 24) {
  const rows = hoursFromNow(uniqueHours(hours), nowIso, count);
  const runs = [];
  for (const row of rows) {
    const date = String(row.time).slice(0, 10);
    const key = timeBandOf(sunOf(date), `${String(row.hour).padStart(2, "0")}:00`);
    if (!key) continue;
    const last = runs.at(-1);
    if (last && last.key === key) last.rows.push(row);
    else runs.push({ key, label: timeBandLabel(key), date, rows: [row] });
  }
  return runs;
}

/**
 * **これから 24 時間**の釣行スコア（D-115）。ホームはこれを使う。
 *
 * `fishingScoreOfDay` は「その日」で切るので、10 時に見ても
 * **もう過ぎた 07 時の点**を大きく出していた（本人の指摘）。
 * ホームは「今の参考情報」なので、これから取れる点でないと役に立たない。
 * 時間別天気・潮位グラフと**同じ 24 時間の窓**に揃える。
 *
 * @param {object[]} hours 予報（2 日ぶん）
 * @param {string} nowIso "YYYY-MM-DDTHH:MM"（JST）
 * @param {(date:string)=>{sun?:object,tide?:object,tideType?:string}|null} contextOf
 *   日付ごとの日の出・潮汐・潮回り。日をまたぐので**行の日付で引く**
 */
export function fishingScoreAhead({
  hours, nowIso, count = 24, contextOf, tideMatters = true, point = null,
}) {
  const today = String(nowIso).slice(0, 10);
  const ctx = (date) => contextOf(date) ?? {};
  const runs = bandRunsAhead(hours, nowIso, (date) => ctx(date).sun ?? null, count);

  const windows = runs.map((run) => {
    const scored = run.rows.map((row) => {
      const date = String(row.time).slice(0, 10);
      const at = `${String(row.hour).padStart(2, "0")}:00`;
      // 潮回りも潮汐も**その行の日付**で引く。夜は日をまたぐ
      return scoreHour({
        row, tide: ctx(date).tide ?? null,
        point: ctx(date).point ?? point, tideMatters,
        band: run.key,
        /* **名前に「明日の」を付けない。** 帯は 4 つ並びで 1 つ 80px ほどしかなく、
           「明日の朝マヅメ」は 3 行に折り返してそのセルだけ背が伸びる。
           明日かどうかは tomorrow で持ち、**時刻の行に出す**（「明日 05:07」）。 */
        label: run.label, at, key: run.key,
      });
    }).filter(Boolean);
    if (!scored.length) return null;
    // ★ではなく掛け合わせた値で比べる（D-139。fishingScoreOfDay と同じ理由）
    const best = scored.reduce((a, b) =>
      ((b.block ? -1 : b.value) > (a.block ? -1 : a.value) ? b : a));
    // マヅメは日の出・日没そのものを時刻として見せる（1 時間刻みに丸めない）
    const sun = ctx(run.date).sun;
    const at = run.key === "morning" && sun?.rise ? sun.rise
      : run.key === "evening" && sun?.set ? sun.set : best.at;
    return { ...best, at, date: run.date, tomorrow: run.date !== today };
  }).filter(Boolean);
  /* **切らない**（D-116）。前は 4 つに切っていたが、それは帯の並びが 4 列
     だったから。並びをやめて 1 時間ごとの★にしたので、
     **円の点は帯の並びではなく 24 時間の最高点**になる。切ると食い違う。 */

  if (!windows.length) return null;
  const best = windows.reduce((a, b) =>
    ((b.block ? -1 : b.value) > (a.block ? -1 : a.value) ? b : a));
  return {
    // 円の点は「これから 24 時間」のまとめなので、日と同じ線で引く（D-139）
    score: best.block ? 1 : starFromValue(best.value, DAY_CUTS),
    value: best.value, block: best.block,
    best, top: best, windows, bands: windows,
    tideType: ctx(today).tideType ?? null, tideMatters,
    fallback: false, ahead: true, from: nowIso, count,
  };
}

/**
 * ★☆ の 5 段階。
 * @param {number} score 1〜5
 * @param {boolean} [opt.html] true なら**点いている分と消えている分を分けた HTML**を返す。
 *   時間別天気のカード（D-118）は段階ごとに色を変えるので、この形が要る。
 *   文字だけでよい場所（一覧・サマリ）はそのまま文字列で受け取る。
 */
export function stars(score, { html = false } = {}) {
  const n = Math.max(0, Math.min(5, Number(score) || 0));
  const on = "★".repeat(n);
  const off = "☆".repeat(5 - n);
  return html
    ? `<span class="on">${on}</span><span class="off">${off}</span>`
    : `${on}${off}`;
}

/**
 * 釣行スコアの説明を出す。「どういう式か」だけでなく
 * 「この日はなぜこの点になったか」を先に示す（式だけでは自分の日に当てはめられない）。
 * @param {ReturnType<typeof fishingScoreOfDay>} day
 */
export function showFishingScoreHelp(day) {
  if (!day) return null;
  const { score, best, tideMatters = true } = day;
  if (!best) return null;

  /* **このモーダルの役目は「なぜこの点なのか」を見せることだけ**（D-136）。
     時間帯ごとの★は時間別天気の帯にもう並んでいるので、ここには載せない。 */

  /* 釣りにならないときは係数を掛けない。**なぜ掛けないのかを書く。**
     「雷だから ★1」で止まると、潮が良かった日に納得できない */
  const blockBlock = !best.block ? "" : `
    <div class="score-gate">
      <div class="sg-head">${icon("warning", { size: 15 })}
        <b>${escapeHtml(best.block.label)}　釣行不可</b></div>
      <div class="sg-body">この日はここで決まります。
        潮がどれだけ良くても、雷や暴風のなかでは釣りになりません。</div>
    </div>`;

  /* **掛け算だと分かる形で出す**（D-139）。
     真ん中が 1.0（ふつう）で、右に伸びれば上げ、左に伸びれば下げ。
     数字だけ並べても「どれが効いたのか」が読み取れない。 */
  const bar = (f) => {
    const span = 0.4;                       // 0.6〜1.4 を端から端に割り当てる
    const w = Math.min(50, (Math.abs(f - 1) / span) * 50);
    return f >= 1
      ? `<span class="fb-fill up" style="left:50%;width:${w}%"></span>`
      : `<span class="fb-fill down" style="right:50%;width:${w}%"></span>`;
  };
  const rows = (best.factors ?? []).filter((f) => f.applicable).map((f) => `
    <li class="${!f.known ? "off" : f.factor >= 1.02 ? "up" : f.factor <= 0.98 ? "down" : ""}">
      <span class="fac-head">
        <span class="fac-name">${escapeHtml(f.label)}</span>
        <span class="fac-value">${escapeHtml(f.known ? (f.value ?? "—") : "取れません")}</span>
        <span class="fac-mul">×${f.factor.toFixed(2)}</span>
      </span>
      <span class="fac-bar">${bar(f.factor)}<span class="fb-mid"></span></span>
      <span class="fac-detail">${escapeHtml(f.detail)}</span>
    </li>`).join("");

  const off = (best.factors ?? []).filter((f) => !f.applicable);
  const unknown = (best.factors ?? []).filter((f) => f.applicable && !f.known);

  /* **次の★までいくつ足りないかを書く**。
     係数が全部 1 を超えているのに ★3、という画面になることがある。
     日の★は「24 時間でいちばん良い時刻どうし」の比べっこなので、
     線が 1.0 ではなく 1.05〜1.14 に引いてある。そこを書かないと
     「全部プラスなのに、なぜ 3 なのか」が読めない（実機で気づいた）。 */
  // このモーダルは日（またはこれから 24 時間）の点なので、線は日のもの
  const nextCut = score < 5 ? DAY_CUTS[score - 1] : null;
  const body = best.block ? "" : `
    <ul class="fac-list">${rows}</ul>
    <div class="fac-total">
      <span class="ft-label">掛け合わせ</span>
      <span class="ft-value">${(best.value ?? 1).toFixed(3)}</span>
      <span class="ft-arrow">→</span>
      <span class="ft-star sc sc-${score}">${stars(score, { html: true })}</span>
    </div>
    ${nextCut == null ? "" : `
      <div class="fac-next">★${score + 1} は <b>${nextCut.toFixed(3)}</b> から。
        日の★は「その日いちばん良い時刻」どうしを比べるので、
        1.00（ふつうの 1 時間）より高いところに線があります。</div>`}
    <div class="list-sub" style="margin-top:8px;line-height:1.6">
      ひとつずつの足し引きではなく、<b>掛け合わせ</b>で決まります。
      どれかが大きく下がれば全体が下がります。
      ${off.length ? `この場所では${off.map((f) => f.label).join("・")}を見ていません。` : ""}
      ${unknown.length
        ? `${unknown.map((f) => f.label).join("・")}は材料が無いので 1.00（ふつう）で置いています。`
        : ""}
    </div>`;

  return showInfoDialog("釣行スコア", `
    <div class="score-top">
      <!-- **sc も付ける**（D-130）。色は .sc .on が --sc から取るので、
           sc-N だけだと色が乗らず、★4 が橙にならない -->
      <span class="score-stars sc sc-${score}">${stars(score, { html: true })}</span>
      <span class="score-num-sm">${score} / 5</span>
    </div>

    <div class="score-input">
      いちばん良いのは <b>${escapeHtml(best.label ?? "—")}
      ${escapeHtml(String(best.at ?? "").slice(0, 5))}</b>。この時間の条件で判定しています。
    </div>

    ${blockBlock}
    ${body}

    <details class="score-note">
      <summary>この判定の細かいところ</summary>
      <div class="list-sub" style="line-height:1.7">
        <p><b>時間帯（マヅメ・夜）は点に入れていません。</b>
        狙う魚と釣り方で良し悪しが逆になるためです。日の出・日没は
        潮位グラフの下に出しているので、そこはご自分で判断してください。</p>
        <p>天気と風は、その時刻にいちばん近い予報を代表値にしています。
        ${tideMatters ? `潮の強さは<strong>その場所の中での速さの比</strong>で見ます。
        大潮か小潮かは見ていません。潮位の振れが小さい湾の奥でも、
        そこでよく流れる時間帯には上がります。` : ""}
        気圧は 3 時間前との差です。</p>
        <p>★の切れ目は、この地域の実測 112 日ぶんの分布から決めています。
        日の★と時間の★では切れ目が違います（日の点は 24 時間のうちいちばん
        良い時間なので、そのぶん高く出るため）。
        目安であり、釣れることを保証するものではありません。</p>
      </div>
    </details>`);
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

/* ---------------- 到達段階（D-092） ----------------
   「釣れた / ボウズ」の二択では、バラシもミスバイトもボウズに落ちてしまう。
   だが**魚がいたこと**こそ、次にどこへ行くかを決める材料になる。
   釣果より件数が多いので、判断材料としてはむしろ厚い。

   並びは上（キャッチ）から下（何も無し）へ。画面でもこの順に出す。

   **「獲れた」とは言わない**（D-093）。あれは持ち帰った、の意味になる。
   リリースする釣りでは合わない。内部の値も landed（ランディングした）で、
   そのあと持ち帰るかどうかとは別の話。バラシと対になる語でもある。
   reaction は「魚がルアーに反応したか」。レシピの反応数はこれで数える。
   目視は反応に入れない。ルアーには触れていないので、ルアーの手柄ではない。 */
export const OUTCOMES = [
  { value: "landed",   label: "キャッチ",    short: "釣果",   iconName: "fish",
    countLabel: "匹数", reaction: true,  tagClass: "tag-mustard",
    hint: "取り込めた（リリース含む）" },
  { value: "lost",     label: "バラシ",      short: "バラシ", iconName: "lost",
    countLabel: "バラした回数", reaction: true, tagClass: "tag-red",
    hint: "掛けたが獲り込めなかった" },
  { value: "bite",     label: "ミスバイト",  short: "アタリ", iconName: "bite",
    countLabel: "アタリの回数", reaction: true, tagClass: "tag-blue",
    hint: "アタリはあったが乗らなかった" },
  { value: "sighting", label: "目視のみ",    short: "目視",   iconName: "sighting",
    countLabel: "見かけた回数", reaction: false, tagClass: "tag-gray",
    hint: "ボイル・チェイス・魚影。ルアーには触れていない" },
  { value: "none",     label: "何も無し",    short: "ボウズ", iconName: "skunk",
    countLabel: null, reaction: false, tagClass: "tag-gray",
    hint: "反応が無かった" },
];

/** 記録から到達段階を取り出す。outcome を知らない古い行にも耐える。 */
export function recordOutcome(record) {
  const value = record?.outcome ?? (record?.is_skunked ? "none" : "landed");
  return OUTCOMES.find((o) => o.value === value) ?? OUTCOMES[0];
}

/**
 * 釣果一覧。読み取りは record_feed ビューから行う（010）。
 * 自分の釣果 + 同じグループの人の公開釣果が、投稿者名つきで返る。
 * 書き込みは fishing_records へ直接行う（他人の行は RLS が拒否する）。
 */
/* 取る列を決め打ちにする（D-126）。
   `select("*")` は record_feed の **44 列**を全部運ぶ。実データで測ると
   1 行 1,420 バイトのうち **611 バイトが列名**で、平均 10 列は値が空だった。
   PostgREST は行ごとにキー名を書き出すので、**値より列名のほうが重い**。
   一覧が使う列だけにすると 1 行 546 バイト（2.6 分の 1）になる。

   **列を減らすと、使っている画面が黙って壊れる。**
   どの画面がどの列を読んでいるかは frontend/tests/record_columns.test.mjs が
   走査して見張っている。列を足す・消すときは、まずそのテストを通すこと。 */
export const RECORD_LIST_COLUMNS = [
  "id", "is_mine", "owner_name", "fished_at", "fished_time",
  "outcome", "is_skunked",
  "fish_label", "fish_name_local", "length_cm", "catch_count", "quantity_note",
  "tide_type", "water_layer",
  "spot_id", "spot_name",
  "lure_label", "lure_category_large", "lure_category_small", "recipe_id",
  "photo_thumb_path", "photo_count",
].join(",");

/** 傾向画面が数えるのに要る列だけ。一覧とは必要なものが違う（座標と天気が要る） */
export const RECORD_TREND_COLUMNS = [
  "id", "is_mine", "fished_at", "fished_time", "outcome", "is_skunked",
  "tide_type", "water_layer", "lure_category_large",
  "spot_name", "spot_spot_type", "spot_entry_style",
  "spot_latitude", "spot_longitude", "weather_snapshot",
].join(",");

/**
 * @param {string} [input.columns] 取る列。既定は一覧に要るぶん
 * @param {boolean} [input.mineOnly] 自分の記録だけ。**取ってから捨てるのをやめる**（D-126）
 */
export async function listRecords({
  limit = 50, spotId = null, columns = RECORD_LIST_COLUMNS, mineOnly = false,
} = {}) {
  let query = client
    .from("record_feed")
    .select(columns)
    /* **釣れた日時の降順**（D-106）。
       fished_at は date で、時刻は別列の fished_time に入っている。
       日付だけで並べると、同じ日の中は created_at＝**登録した順**になり、
       あとから時刻を直しても並びが変わらなかった。
       時刻の無い記録はその日の先頭に置く（本人の指定）。
       created_at は同じ日・同じ時刻のときの最後の同着解消として残す。 */
    .order("fished_at", { ascending: false })
    .order("fished_time", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (spotId) query = query.eq("spot_id", spotId);
  // **サーバー側で絞る。** 傾向画面は 1000 件取ってから JS で捨てていた
  if (mineOnly) query = query.eq("user_id", await requireUserId());
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * 誰の釣果かを示すタグ（D-064）。自分のものにも付ける。
 * 色はカラシ（自分）と青（ほかの人）。カラシはこのアプリで
 * 「自分のもの」を指す色（スコアの円・ナビの選択中）なので、意味が揃う。
 */
/**
 * 一覧のタイトルに付ける到達段階の見出し（D-097）。
 *
 * **ピルにしない。** 投稿者の名前も同じ形・同じ色のピルだったので、
 * 「誰の記録か」と「その釣行の結果」が同じ重さに見えていた。
 * 枠を外して色付きの語にすると、タイトルに掛かる修飾として読める。
 *
 * **キャッチにも出す**（D-098）。はじめは「例外だけに印を付ける」つもりで
 * 何も出していなかったが、それだと読む側が「印が無い＝キャッチ」という規則を
 * 知っている必要がある。全部の行が自分の結果を名乗るほうが迷わない。
 * ただしキャッチは灰色に沈めて、目立つのは例外のほうにする。
 *
 * 語は `short`（釣果・バラシ・アタリ・目視）を使う。`label`（キャッチ）だと
 * 幅を食って、「マルスズキ 70cm」が折り返す。
 */
export function outcomeLead(record) {
  const outcome = recordOutcome(record);
  return `<span class="outcome-lead ${outcome.value}">`
    + `${icon(outcome.iconName, { size: 13 })}${outcome.short}</span>`;
}

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
  const name = record.fish_label ?? record.fish_name_local ?? record.fish_species?.name;
  if (name) return name;
  // 魚種を入れていないときの言い方は、到達段階で変わる（D-092）。
  // バラシに「釣果」と出ると、キャッチしたように読めてしまう
  const outcome = recordOutcome(record);
  return outcome.value === "landed" ? "釣果" : "魚";
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

/** 種別が空でも画像として扱う（D-091）。
    Android の写真アプリや共有経由で選ぶと `type` が空になることがある。
    そこで弾いていたので、**何も言わずに消える**という見え方になっていた。
    開けるかどうかは実際に読んで確かめ、だめなら理由を出す。 */
export function looksLikeImage(file) {
  return file.type ? file.type.startsWith("image/") : true;
}

// これより大きいファイルは原寸でデコードしない（D-091）。
// 1 億画素だと原寸のビットマップだけで 400MB を超え、端末によっては落ちる。
const PHOTO_BIG_FILE_BYTES = 6 * 1024 * 1024;

/**
 * 画像を 1 回だけデコードする。手前から順に試す（D-061 / D-091）。
 * 大きなファイルは**最初から縮小しながら**読む。原寸のビットマップを作らずに済む。
 * 小さなファイルに縮小指定を使うと引き伸ばしてしまうので、そちらは原寸から。
 */
async function loadImage(file) {
  const attempts = file.size > PHOTO_BIG_FILE_BYTES
    ? [PHOTO_MAX_EDGE, 1024, 640, 0]
    : [0, PHOTO_MAX_EDGE, 1024, 640];
  for (const edge of attempts) {
    try {
      return await createImageBitmap(file, edge
        // 幅だけ指定すれば高さは比率で決まる。画素数が減るぶんメモリの山が低くなる
        ? { imageOrientation: "from-image", resizeWidth: edge, resizeQuality: "high" }
        : { imageOrientation: "from-image" });
    } catch { /* 次の手を試す */ }
  }

  // createImageBitmap が受け付けない形式の保険。ブラウザ側で間引いて読んでくれる
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      // 何が起きたのか分かるよう、種別と大きさを添える
      const mb = (file.size / 1024 / 1024).toFixed(1);
      reject(new Error(
        `この画像は開けませんでした（${file.type || "形式不明"} / ${mb} MB）。`
        + "HEIC で撮影している場合は、カメラの設定を JPEG にするか、"
        + "写真アプリで JPEG に変換してからお試しください。"
        + "大きすぎて端末のメモリに乗らないこともあります。"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality);
  });
}

/**
 * 選んだ時点で縮小しておく（D-091）。
 * 記録するときにまとめて縮小していたので、
 *   - 選んでから何も起きず、上げられたのかどうか分からない
 *   - 一覧の下絵に**原本**を出していて、大きな写真では出るまでに時間がかかる
 * という状態だった。ここで済ませておけば、下絵は縮小済みの小さな画像で出せるし、
 * 開けない写真はその場で分かる。
 *
 * デコードは 1 回だけ。表示用とサムネイルで 2 回デコードすると、
 * 大きな写真ではメモリの山が 2 倍になる（D-061）。
 */
export async function preparePhoto(file) {
  const source = await loadImage(file);
  try {
    const full = await renderImage(source);
    const thumb = await renderImage(source, {
      maxEdge: PHOTO_THUMB_EDGE, budget: PHOTO_THUMB_BUDGET_BYTES,
    });
    return { full, thumb, name: file.name, previewUrl: URL.createObjectURL(thumb.blob) };
  } finally {
    source.close?.();
  }
}

/* ---- 消し損ねた実体の後始末（D-125） ----
   上げる途中で失敗したときの巻き戻しは、以前 `.catch(() => {})` で
   握りつぶしていた。台帳に載っていない実体は photo_visible_to_me が false を
   返すので**持ち主本人からも見えず**、誰にも気づかれないまま無料枠を食う。

   **消せなかったら書き留めて、次に写真を触ったときに掃き出す。**
   画面には出さない（使う人には直しようが無い）。 */

/** 消す。消せなければ orphan_objects に書き留める。**ここ自体は投げない。** */
async function removeOrNote(paths, cause) {
  const { error } = await client.storage.from(PHOTO_BUCKET).remove(paths)
    .catch((thrown) => ({ error: thrown }));
  if (!error) return;
  await noteOrphans(paths, "upload_rollback", error);
}

/** 消せなかったパスを書き留める。**ここ自体は投げない。**
    投げると「写真を上げられません」の理由がすり替わる。 */
async function noteOrphans(paths, reason, cause) {
  try {
    const userId = await requireUserId();
    await client.from("orphan_objects").upsert(
      [...new Set(paths.filter(Boolean))].map((path) => ({
        user_id: userId, bucket: PHOTO_BUCKET, path, reason,
        // 秘密は入れない。あとで人が読んで見当が付く長さだけ残す
        detail: String(cause?.message ?? cause ?? "").slice(0, 200),
      })),
      { onConflict: "bucket,path", ignoreDuplicates: true },
    );
  } catch { /* 元の失敗を上書きしない */ }
}

/* 1 画面につき 1 回でよい。**待たせない**ので、呼び出し側は await しないこと */
let sweptThisLoad = false;

/**
 * 書き留めてある実体を消しに行く。消えたら行も消す。
 * **1 件ずつ消す。** まとめて消すと、1 つ失敗したときにどれが残ったか分からない。
 * @returns {Promise<number>} 片付いた件数
 */
export async function sweepOrphanObjects(limit = 10) {
  if (sweptThisLoad) return 0;
  sweptThisLoad = true;
  try {
    const userId = await requireUserId();
    const { data } = await client.from("orphan_objects")
      .select("id, path, attempts")
      .eq("user_id", userId).eq("bucket", PHOTO_BUCKET)
      .order("created_at").limit(limit);
    if (!data?.length) return 0;

    let cleaned = 0;
    for (const row of data) {
      const { error } = await client.storage.from(PHOTO_BUCKET).remove([row.path])
        .catch((thrown) => ({ error: thrown }));
      if (error) {
        await client.from("orphan_objects")
          .update({ attempts: (row.attempts ?? 0) + 1, last_tried_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }
      await client.from("orphan_objects").delete().eq("id", row.id);
      cleaned += 1;
    }
    return cleaned;
  } catch {
    return 0;                    // 掃除の失敗で画面を止めない
  }
}

/** 釣果に写真を 1 枚追加する（表示用とサムネイルの 2 つを上げる）。 */
export async function uploadRecordPhoto(recordId, file, sortOrder = 0) {
  const prepared = await preparePhoto(file);
  try {
    return await uploadPreparedPhoto(recordId, prepared, sortOrder);
  } finally {
    URL.revokeObjectURL(prepared.previewUrl);
  }
}

/** 縮小済みの写真を上げる。 */
export async function uploadPreparedPhoto(recordId, { full, thumb }, sortOrder = 0) {
  const userId = await requireUserId();
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
    await removeOrNote([path], uploadedThumb.error);
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
    await removeOrNote([path, thumbPath], error);
    throw error;
  }
  sweepOrphanObjects();          // 掃き出しは待たない（D-125）
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
  if (error) {
    /* ここは投げる（使う人が消そうとした操作なので、黙って成功に見せない）。
       ただし**投げる前に書き留める**。やり直してもらえるとは限らない */
    await noteOrphans(paths, "delete_failed", error);
    throw error;
  }
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

/* ---------------- 画面共通 ---------------- */

/** ボトムナビを描画する。current は home / tide / map / records / recipes。
    設定はここに置かない（毎日開く場所ではないため、ホームのヘッダーから開く）。 */
/* ---------------- 圏外でも開けるようにする（D-096） ----------------
   堤防や河口では電波が無いことがある。Service Worker を登録しておくと、
   画面と、一度見た潮汐が端末に残る。日の出・日没と潮回りはもともと
   端末側の計算なので（D-056 / D-062）、電波が無くても出る。

   **勝手に古い画面を出さない**のが条件。画面は必ずネットワークを先に試し、
   圏外のときだけ手持ちを出す（sw.js 側）。D-088 / D-089 の帯もそのまま効く。 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // file:// で開いたときは登録できない。手元での確認を邪魔しない
  if (location.protocol !== "https:" && location.hostname !== "127.0.0.1"
      && location.hostname !== "localhost") return;
  navigator.serviceWorker.register("sw.js").catch(() => { /* 使えなくても本体は動く */ });
}

/** ログアウト時に、端末に残った自分のデータを消す。 */
export function clearOfflineData() {
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-data" });
}

/* 圏外の帯。いま出ているものが古いかもしれない、とだけ伝える。
   D-088 の「新しい版があります」とは別物なので、色も位置も変えてある。 */
function renderOfflineBar() {
  const existing = document.querySelector(".offline-bar");
  if (navigator.onLine) { existing?.remove(); return; }
  if (existing) return;
  document.body.insertAdjacentHTML("afterbegin",
    `<div class="offline-bar" role="status">圏外です。保存してある内容を表示しています</div>`);
}

export function watchOnlineState() {
  renderOfflineBar();
  window.addEventListener("online", renderOfflineBar);
  window.addEventListener("offline", renderOfflineBar);
}

/**
 * 先の潮汐を取っておく（D-096）。
 * 圏外で役に立つのは「その日たまたま開いていた分」ではなく「これから行く日」なので、
 * 電波があるうちに 1 週間ぶんを温めておく。1 日ぶんは数 KB で、応答は
 * Service Worker が持つ。圏外・未登録のときは何もしない。
 */
export async function warmTideCache(point, days = 7) {
  if (!point || !navigator.onLine || !navigator.serviceWorker?.controller) return;
  const today = todayInJst();
  for (let i = 0; i < days; i += 1) {
    // 1 本ずつ順に。まとめて投げると圏内が細いときに他の通信を押しのける
    await fetchTide(point.station, addDays(today, i)).catch(() => null);
  }
}

/* ---------------- 配った版が端末に届いているか（D-088） ----------------
   GitHub Pages は HTML も JS も max-age=600 で配る。配信は成功しているのに
   端末には 10 分ほど古い画面が残るし、ホーム画面から起動したまま
   閉じずに使っていると、それより長く残る。
   実際に「アイコンは変わったのにレシピの画面が変わらない」が起きた。

   版だけを毎回取り直して（no-store・数十バイト）、読み込んである版と違えば知らせる。
   **勝手に読み込み直さない。** 入力の途中で消えるほうが困る。 */
export const APP_VERSION = "__APP_VERSION__";   // 配信時に GitHub Actions が差し替える

function showUpdateBar(latest) {
  if (document.querySelector(".update-bar")) return;
  document.body.insertAdjacentHTML("afterbegin",
    `<button type="button" class="update-bar">新しい版があります。タップして読み込み直す</button>`);
  document.querySelector(".update-bar").addEventListener("click", () => {
    /* 同じ URL のままだと端末が持っている古い HTML をそのまま返すことがある。
       版を付けた別の URL にすると、必ず取りに行く。 */
    const url = new URL(location.href);
    url.searchParams.set("v", latest);
    location.replace(url.toString());
  });
}

/* 画面から画面へ移るときも版を持ち回る（D-089）。

   D-088 で CSS と JS には版を打ったが、**HTML そのものには打てない**
   （GitHub Pages はヘッダーを触れず、一律 max-age=600 で配る）。
   その結果、設定は新しいのにレシピだけ古い、という食い違いが実際に起きた。
   画面ごとにキャッシュの期限が別々に来るため。

   古い HTML は古い app.js を読むので、D-088 の帯も出せない。
   そこで、いる画面が新しければ、そこから開く画面も必ず新しくなるようにする。
   版を付けた URL は端末が持っていないので、必ず取りに行く。 */
export function withVersion(href) {
  if (APP_VERSION.startsWith("__")) return href;      // 手元では何もしない
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return href;    // 外部リンクは触らない
  if (!url.pathname.endsWith(".html")) return href;   // HTML 以外は版を打ってある
  url.searchParams.set("v", APP_VERSION);
  return url.pathname + url.search + url.hash;
}

/** 画面を移る。version を引き継ぐ。戻るを残したくないときは replace: true。 */
export function navigate(href, { replace = false } = {}) {
  const target = withVersion(href);
  if (replace) location.replace(target);
  else location.href = target;
}

/* 圏外対応は全画面で効かせたいので、読み込まれた時点で仕掛ける（D-096） */
registerServiceWorker();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", watchOnlineState, { once: true });
} else {
  watchOnlineState();
}

/* リンクは踏まれる直前に書き換える（捕捉フェーズ）。
   すべての画面の <a> を書き換えて回るより、ここ 1 か所で済む。 */
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[href]");
  if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  link.setAttribute("href", withVersion(href));
}, true);

export async function checkForUpdate() {
  if (APP_VERSION.startsWith("__")) return null;   // 手元では差し替わっていないので何もしない
  try {
    const response = await fetch(`assets/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const latest = (await response.json()).v;
    if (!latest || latest === APP_VERSION) return null;
    showUpdateBar(latest);
    return latest;
  } catch {
    return null;                                   // 圏外なら黙って諦める
  }
}

export function renderNav(current) {
  const items = [
    ["home", "index.html", "home", "ホーム"],
    ["tide", "tide.html", "tide", "潮汐"],
    ["map", "spots.html", "map", "マップ"],
    ["records", "records.html", "records", "釣果"],
    // レシピとタックルは別物なので、ナビでも並べて置く（D-073）。
    // 「レシピ」の下にタックルがぶら下がっていると、名前と中身が食い違って迷う。
    // 6 つ目を足すと 1 枠が細くなるのを気にしていたが、実際に測ると
    // 幅 360px の画面でも 1 枠 60px あり、いちばん長い「タックル」でも 41px で収まる。
    ["recipes", "recipes.html", "recipes", "レシピ"],
    ["tackle", "tackle.html", "rod", "タックル"],
  ];
  document.body.insertAdjacentHTML("beforeend", `
    <nav class="bottom-nav">
      ${items.map(([key, href, iconName, label]) => `
        <a class="nav-item${key === current ? " active" : ""}" href="${href}">
          ${icon(iconName, { size: 21, className: "nav-icon" })}<span>${label}</span>
        </a>`).join("")}
    </nav>`);
  renderIcons();
  checkForUpdate();          // 画面を開くたびに 1 回。待たない
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

/**
 * 名前を変える。**釣果に残っている名前も一緒に付け替える**（D-067）。
 * タックル名は持ち物につけた名前であって釣行時の事実ではないので、
 * 直したら過去の釣果も同じものを指していてほしい。
 * @returns {Promise<number>} 付け替えた釣果の件数
 */
export async function renameTackle(kind, oldName, newName) {
  const { data, error } = await client.rpc("rename_tackle", {
    p_kind: kind, p_old: oldName, p_new: newName,
  });
  if (error) throw error;
  return data ?? 0;
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
/**
 * レシピごとの実績。{ recipeId: { landed, reaction } }。
 *
 * **以前はボウズも 1 件として数えていた**（recipe_id の付いた行を無条件に
 * 数えていた）。「実績」と書いてあるのに釣れなかった釣行が混ざるので、
 * 到達段階（D-092）を入れるついでに分けた。
 *   landed   … キャッチした匹数
 *   reaction … バラシ・ミスバイトの回数。ルアーに反応があったということ
 * 目視は入れない。ルアーには触れていないので、ルアーの手柄ではない。
 */
export async function recipeCatchCounts() {
  const { data, error } = await client
    .from("fishing_records")
    .select("recipe_id, outcome, is_skunked, catch_count")
    .not("recipe_id", "is", null);
  if (error) throw error;
  const counts = {};
  for (const row of data) {
    const outcome = recordOutcome(row);
    const entry = counts[row.recipe_id] ??= { landed: 0, reaction: 0 };
    if (outcome.value === "landed") entry.landed += row.catch_count ?? 0;
    else if (outcome.reaction) entry.reaction += row.catch_count ?? 0;
  }
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
/* 色は**種別ごとに必ず違う**こと（D-110）。地図のピンの色と凡例がこれで決まる。
   もとは 4 組が同じ色だった（磯 = 管理釣り場、サーフ = 汽水湖、
   水路・運河 = 河川、テトラ帯 = 未設定）。凡例に別々に並んでいるのに
   地図では見分けられず、凡例が嘘をついている状態だった。

   守っていること（`frontend/tests/spot_colors.test.mjs` が毎回確かめる）:
   - どの 2 色も Lab 空間で ΔE 22 以上（隣に並べて別の色に見える）
   - ピンの中の線（rgba(10,21,32,0.85)）と暗い背景の両方に対して 3.5:1 以上。
     **ピンは色が地、線が暗い**ので、暗い色にすると中身が読めなくなる
   - サーフの青・磯の緑・港湾のからしは動かさない。
     画面の他の色（--blue / --green / --mustard）と同じで、覚えられているため */
export const SPOT_TYPES = [
  // 海
  { value: "surf",          label: "サーフ",     color: "#4A9ECC", iconName: "surf" },
  { value: "cobble",        label: "ゴロタ場",   color: "#96836D", iconName: "cobble" },
  { value: "rock",          label: "磯",         color: "#4CAF50", iconName: "rock" },
  { value: "port",          label: "港湾・堤防", color: "#C9A84C", iconName: "port" },
  { value: "tetra",         label: "テトラ帯",   color: "#6E7E93", iconName: "tetra" },
  // 汽水
  { value: "rivermouth",    label: "河口",       color: "#1E9E92", iconName: "rivermouth" },
  { value: "tidalflat",     label: "干潟",       color: "#B0764A", iconName: "tidalflat" },
  { value: "brackish_lake", label: "汽水湖",     color: "#C078CE", iconName: "lake" },
  { value: "channel",       label: "水路・運河", color: "#E06E85", iconName: "channel" },
  // 淡水
  { value: "river",         label: "河川",       color: "#6A82F0", iconName: "river" },
  { value: "lake",          label: "湖沼・池",   color: "#6FD6E4", iconName: "lake" },
  { value: "managed",       label: "管理釣り場", color: "#BEDB6B", iconName: "managed" },
];

/* 立ち位置（D-099 / D-100）。**種別（SPOT_TYPES）とは別の軸。**
   同じ場所でも、岸から投げるのか、立ち込むのか、船で出るのかで別の釣りになる。
   種別の値にすると「河川でなくなる」ので、掛け合わせられる形で持つ。
   軸の中身は「どこに身を置くか」なので、船の上もここに入る。
   未設定（null）は残す。以後の登録で決めたくないときのため。 */
export const ENTRY_STYLES = [
  { value: "bank",   label: "おかっぱり",   short: "おかっぱり", iconName: "boot-dry" },
  { value: "wading", label: "ウェーディング", short: "ウェーディング", iconName: "wading" },
  { value: "boat",   label: "ボート",       short: "ボート",     iconName: "boat" },
];

export function entryStyle(value) {
  return ENTRY_STYLES.find((e) => e.value === value) ?? null;
}

export const WATER_TYPES = [
  { value: "saltwater",  label: "海水" },
  { value: "brackish",   label: "汽水" },
  { value: "freshwater", label: "淡水" },
];

export function spotType(value) {
  // 未設定も**種別の 1 つとして色を持つ**。テトラ帯と同じ灰色だったので分けた（D-110）
  return SPOT_TYPES.find((t) => t.value === value)
    ?? { value: null, label: "未設定", color: "#C9CED3", iconName: "map-pin" };
}

/* 種別の並び（D-108）。海 → 汽水 → 淡水（SPOT_TYPES のとおり）。
   **管理釣り場だけは最後に置く。** SPOT_TYPES の並びが変わっても最後に来るよう、
   明示的に外して足す。未設定はその手前。
   もとはスポットマップの中だけにあった。スポットを選ぶところが 3 画面に増えたので
   共通に出す（同じ並びが 3 通りあると、どれが正か分からなくなる）。 */
const SPOT_TYPE_PINNED_LAST = "managed";
export const SPOT_TYPE_ORDER = [
  ...SPOT_TYPES.map((t) => t.value).filter((v) => v !== SPOT_TYPE_PINNED_LAST),
  null,                       // 種別未設定
  SPOT_TYPE_PINNED_LAST,
];

/**
 * スポットを種別ごとにまとめる（D-108）。中身が無い種別は返さない。
 * @param {object[]} spots
 * @returns {{type: object, spots: object[]}[]} SPOT_TYPE_ORDER の並び
 */
export function groupSpotsByType(spots) {
  const byType = new Map(SPOT_TYPE_ORDER.map((v) => [v, []]));
  for (const spot of spots ?? []) {
    // 知らない種別の値が入っていても落とさない。「未設定」に寄せる
    const key = byType.has(spot.spot_type ?? null) ? (spot.spot_type ?? null) : null;
    byType.get(key).push(spot);
  }
  return SPOT_TYPE_ORDER
    .map((value) => ({ type: spotType(value), spots: byType.get(value) ?? [] }))
    .filter((g) => g.spots.length);
}

export function waterLabel(value) {
  return WATER_TYPES.find((w) => w.value === value)?.label ?? "—";
}

/* 感潮（潮汐が届くか）。**塩分とは別の軸**（D-134）。

   国土交通省「河川砂防技術基準 調査編」第14章:
     感潮区間 … 河口から、潮汐の変動によって水位が変動する区間
     汽水域   … 河川水と海水が混合する部分。塩分 0.5〜30‰
   同基準は「感潮域にも淡水の区間が存在し、水位に対する潮汐の影響は
   塩分濃度が 0.5‰ より低い区間にまで及ぶため、感潮域と汽水域は
   必ずしも一致しない」と明記している。包含関係は 感潮域 ⊃ 汽水域。

   **だから水域から感潮は導けない。** 5km 上流の淡水でも潮位は動く。 */
export const TIDE_INFLUENCES = [
  { value: "tidal", label: "潮汐あり", iconName: "tide" },
  { value: "none",  label: "潮汐なし", iconName: "close" },
];

/** 指定が無いとき（自動）に水域から決まる既定。トリガーと同じ規則。 */
export function defaultTidal(waterType) {
  return waterType !== "freshwater";
}

/** そのスポットで潮汐が効くか。手の指定が優先、無ければ水域から。 */
export function spotIsTidal(spot) {
  if (spot?.tide_influence === "tidal") return true;
  if (spot?.tide_influence === "none") return false;
  return defaultTidal(spot?.water_type);
}

/**
 * 水域の表示名。**淡水でも潮汐が効くなら「淡水（感潮）」**と出す（D-134）。
 * 汽水は定義上いつも感潮なので、わざわざ書かない。
 */
export function spotWaterLabel(spot) {
  const base = waterLabel(spot?.water_type);
  if (spot?.water_type === "freshwater" && spotIsTidal(spot)) return `${base}（感潮）`;
  // 海水・汽水で手動で外してあるときは、そのことが分かるようにする
  if (spot?.water_type !== "freshwater" && !spotIsTidal(spot)) return `${base}（潮汐なし）`;
  return base;
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

/* ---------------- お知らせ（D-074） ----------------
   どこまで読んだかは端末内にだけ持つ。DB に置くほどのものではないし、
   端末ごとに違っていて困る種類の情報でもない。 */

const NEWS_SEEN_KEY = "tidebase.newsSeen";

/** ここまで読んだ、という印（お知らせの日時 "YYYY-MM-DD HH:MM"）。 */
export function markNewsSeen(date) {
  if (date) localStorage.setItem(NEWS_SEEN_KEY, String(date));
}

/** 未読のお知らせがあるか。読み込めなければ「無い」ことにする（赤い点を出さない）。 */
export async function hasUnreadNews() {
  try {
    const response = await fetch(`assets/news.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return false;
    const latest = (await response.json())?.updates?.[0]?.at;
    if (!latest) return false;
    // "YYYY-MM-DD HH:MM" なので、文字列のまま比べて新旧が合う（桁が揃っているため）
    return latest > (localStorage.getItem(NEWS_SEEN_KEY) ?? "");
  } catch {
    return false;
  }
}

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

/* ============================================================
   地名でスポットの位置を探す（D-069）

   報告: 地元の海辺や湖ならすぐピンを指せるが、少し離れた地や山の中だと
   ピンを立てるのが難しい。

   初期表示は浜名湖なので、たとえば長野の湖に立てるには、
   縮小 → 移動 → 拡大を何度も繰り返すことになる。指で追える距離ではない。

   探し方を 2 つ用意する。どちらも同じ入力欄に入れる。
     1. 地名・住所（例「野尻湖」「静岡県浜松市西区舘山寺町」）… 国土地理院の地名検索
     2. 座標や地図アプリの URL の貼り付け … 通信なしでその場で読む
   2 を必ず添えるのは、1 が外部サービス頼みだから。地名検索が落ちても、
   Google マップで探して URL を貼れば必ず登録できる、という逃げ道を残す。
   （Google マップは漁港・ダム・湖の収録が圧倒的に厚く、みんな使い慣れてもいる）
   ============================================================ */

/** 地名検索がつながらなかったときの目印。UI で貼り付けの案内に切り替える。 */
export class PlaceSearchUnavailable extends Error {}

/**
 * 国土地理院 地名検索。**住所（と大きな地名）の索引**なので、
 * 「アルクスポンド焼津」のような施設名では何も返らない。
 * 地図タイルと同じ提供元なので、出典の扱いは増えない。
 */
async function searchPlaceGsi(q) {
  // ヘッダーは足さない。付けると CORS の事前確認（preflight）を招きかねず、
  // この API は付けなくても JSON を返す
  const response = await fetch(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`,
  );
  if (!response.ok) throw new Error(`GSI ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("GSI の応答を読めません");
  return data.map((feature) => {
    // GeoJSON なので coordinates は [経度, 緯度] の順。逆に読むと地球の裏側に飛ぶ
    const [lng, lat] = feature?.geometry?.coordinates ?? [];
    return {
      name: String(feature?.properties?.title ?? "").trim(),
      detail: "", source: "gsi",
      lat: Number(lat), lng: Number(lng),
    };
  });
}

/**
 * OpenStreetMap（Nominatim）。**施設や地物の索引**なので、
 * 管理釣り場・湖・漁港・ダムのような「住所ではない場所」はこちらが拾う。
 * 地図タイルには使っていないが、検索だけ借りる。
 * 重い使い方はしない約束なので、押したときだけ 1 回投げる。
 */
async function searchPlaceOsm(q) {
  const params = new URLSearchParams({
    q, format: "jsonv2", limit: "10", countrycodes: "jp", "accept-language": "ja",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!response.ok) throw new Error(`OSM ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("OSM の応答を読めません");
  return data.map((place) => {
    const display = String(place?.display_name ?? "").trim();
    const name = String(place?.name ?? "").trim() || display.split(",")[0].trim();
    // display_name は「名前, 市, 県, 日本」の並び。先頭の名前を除いた残りを説明に回すと、
    // 同じ名前の場所が並んだときに見分けられる
    const detail = display.startsWith(name)
      ? display.slice(name.length).replace(/^[,、]\s*/, "")
      : display;
    return {
      name, detail, source: "osm",
      lat: Number(place?.lat), lng: Number(place?.lon),
    };
  });
}

const PLACE_SOURCES = [searchPlaceGsi, searchPlaceOsm];

/** 同じ場所が両方から返ることがある。名前が同じで 200m 以内なら 1 つにまとめる。 */
function isSamePlace(a, b) {
  return a.name === b.name
    && Math.abs(a.lat - b.lat) < 0.002 && Math.abs(a.lng - b.lng) < 0.002;
}

/**
 * 名前がどれだけ探した言葉に近いか。小さいほど前に出す。
 * これが無いと、「アルクスポンド焼津」で住所側が拾った「焼津市」が先頭に来てしまう。
 */
function placeRelevance(name, q) {
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (q.includes(name)) return 3;
  return 4;
}

/**
 * 地名・住所・施設名から座標を引く。
 * 住所（国土地理院）と施設・地物（OpenStreetMap）は索引の中身が別物なので、
 * **両方に投げて混ぜる**。片方が落ちても、もう片方の結果を返す。
 * @returns {Promise<Array<{name: string, detail: string, source: string, lat: number, lng: number}>>}
 */
export async function searchPlace(query) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const settled = await Promise.allSettled(PLACE_SOURCES.map((search) => search(q)));
  // 全部だめなときだけ「つながらなかった」。片方生きているなら結果を出す
  if (settled.every((r) => r.status === "rejected")) {
    throw new PlaceSearchUnavailable("地名検索につながりませんでした。");
  }

  const merged = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const hit of result.value) {
      if (!hit.name || !isCoordinateInJapan(hit.lat, hit.lng)) continue;
      if (merged.some((kept) => isSamePlace(kept, hit))) continue;
      merged.push(hit);
    }
  }
  return merged
    .sort((a, b) => placeRelevance(a.name, q) - placeRelevance(b.name, q))
    .slice(0, 8);   // 候補が 20 件も並ぶと、かえって選べない
}

/**
 * 短縮 URL を座標に開く（Edge Function 経由・D-072）。
 * ブラウザからはリダイレクトを追えない（goo.gl は CORS を許していないので、
 * 飛んだ先の URL が読めない）。サーバー側で 1 回踏んでもらう。
 * @returns {Promise<{lat:number, lng:number, name:string, approximate:boolean}>}
 */
export async function resolveMapLink(url) {
  const { data: { session } } = await client.auth.getSession();
  const response = await fetchWithTimeout(`${config.supabaseUrl}/functions/v1/resolve-map-link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session?.access_token ?? ""}`,
    },
    body: JSON.stringify({ url }),
    timeout: 20000,   // リダイレクトを踏んでから住所を引くので、少し長めに待つ
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "リンクを開けませんでした。");
  return body;
}

/** 短縮 URL は開かないと座標が入っていない。貼られたら気づけるようにしておく。 */
const SHORT_MAP_LINK = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i;

export function isShortMapLink(text) {
  return SHORT_MAP_LINK.test(String(text ?? "").trim());
}

/**
 * 座標や地図アプリの URL を、通信なしで座標として読む。
 * 読めなければ null（＝地名として検索する）。
 */
export function parseLatLng(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;

  const pick = (lat, lng) => {
    const y = Number(lat), x = Number(lng);
    // 緯度と経度で範囲が違う。ここを 1 つの条件にまとめると南北と東西の取り違えを見逃す
    if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
    if (Math.abs(y) > 90 || Math.abs(x) > 180) return null;
    return { lat: y, lng: x };
  };

  // Google マップの URL は「!3d緯度!4d経度」に**その場所**が入る。
  // 先頭の「@緯度,経度」は画面の中心なので、地点そのものとは少しずれる。こちらを先に見る
  const place = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (place) return pick(place[1], place[2]);

  const view = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (view) return pick(view[1], view[2]);

  // ?q=緯度,経度 / ?ll=緯度,経度（Apple マップ）/ geo:緯度,経度
  const query = s.match(/[?&](?:q|ll|daddr|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i)
    ?? s.match(/^geo:(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i);
  if (query) return pick(query[1], query[2]);

  // 素の「34.7108, 137.5972」。URL の中の数字を拾わないよう、全体が座標のときだけ
  const pair = s.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (pair) return pick(pair[1], pair[2]);

  return null;
}

/**
 * どのスポットを見ているかの帯と、押すと開く一覧を作る（D-108）。
 *
 * **ホームと潮汐詳細で同じものを使う。** 前はホームが `<select>`、
 * 潮汐詳細が横スクロールのタブだった。タブは 17 件あっても 5 件ほどしか見えず、
 * 横に流せること自体が伝わっていなかった。
 *
 * `<select>` をやめたのは、`<option>` の中に**アイコンを描けない**から。
 * 種別の色とアイコン、共有スポットの目印は、どれも文字では代えられない。
 * 見た目はスポットマップの一覧に合わせる（同じものを 2 通りに見せない）。
 *
 * @param {HTMLElement} container 中身は差し替える
 * @param {object}   opts
 * @param {object[]} opts.spots     出すスポット
 * @param {object|null} opts.selected いま選んでいるもの
 * @param {(spot: object) => void} opts.onPick 選ばれたとき（同じものを選んだら呼ばない）
 * @param {string}   [opts.title]   一覧の見出し
 */
export function attachSpotPicker(container, { spots, selected, onPick, title = "スポットを選ぶ" }) {
  container.classList.add("spot-picker");
  container.hidden = !(spots ?? []).length;
  if (container.hidden) return { close: () => {} };

  const type = spotType(selected?.spot_type);
  container.innerHTML = `
    <button type="button" class="spot-picker-bar" aria-haspopup="listbox" aria-expanded="false">
      <span class="thumb" style="background:${type.color}22;color:${type.color}"
        >${icon(type.iconName, { size: 17 })}</span>
      <span class="picked">${escapeHtml(selected?.name ?? "スポットを選ぶ")}</span>
      <span class="caret">${icon("chevron-down", { size: 14 })}</span>
    </button>
    <div class="spot-picker-sheet" hidden>
      <div class="spot-picker-back"></div>
      <div class="spot-picker-panel" role="listbox" aria-label="${escapeHtml(title)}">
        <div class="spot-picker-head">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="spot-picker-close" aria-label="閉じる">✕</button>
        </div>
        <div class="spot-picker-list"></div>
      </div>
    </div>`;

  const bar = container.querySelector(".spot-picker-bar");
  const sheet = container.querySelector(".spot-picker-sheet");
  const list = container.querySelector(".spot-picker-list");

  /* 種別ごとにまとめる。**「自分 / 共有」では分けない**（D-108）。
     場所を選ぶときに知りたいのは誰のものかではなく、どんな場所か。
     共有のものは左の青線で分かる（一覧の他の画面と同じ目印） */
  list.innerHTML = groupSpotsByType(spots).map(({ type: t, spots: group }) => `
    <div class="section-label spot-group">
      <span>${icon(t.iconName, { size: 13 })} ${escapeHtml(t.label)}</span>
      <span class="note">${group.length}</span>
    </div>
    ${group.map((s) => {
      const entry = entryStyle(s.entry_style);
      const on = s.id === selected?.id;
      return `
        <button type="button" class="list-item spot-pick${s.is_mine ? "" : " shared"}${on ? " on" : ""}"
                role="option" aria-selected="${on}" data-id="${escapeHtml(s.id)}">
          <span class="thumb" style="background:${t.color}22;color:${t.color}"
            >${icon(t.iconName, { size: 19 })}</span>
          <span class="list-body">
            <span class="list-title">${escapeHtml(s.name ?? "無名スポット")}${
              s.low_tide_only ? ` ${icon("warning", { size: 13 })}` : ""}</span>
            <span class="list-sub">${escapeHtml(spotWaterLabel(s))}${
              entry ? ` · ${icon(entry.iconName, { size: 12 })} ${escapeHtml(entry.short)}` : ""}${
              s.is_mine ? "" : " · 共有"}</span>
          </span>
          <span class="list-aside">${on ? icon("check", { size: 16 }) : ""}</span>
        </button>`;
    }).join("")}`).join("");

  const open = () => {
    sheet.hidden = false;
    bar.setAttribute("aria-expanded", "true");
    // 選んでいるものが画面外だと「どこにいるか」が分からない
    list.querySelector(".spot-pick.on")?.scrollIntoView({ block: "center" });
  };
  const close = () => {
    sheet.hidden = true;
    bar.setAttribute("aria-expanded", "false");
  };

  bar.addEventListener("click", () => (sheet.hidden ? open() : close()));
  sheet.querySelector(".spot-picker-back").addEventListener("click", close);
  sheet.querySelector(".spot-picker-close").addEventListener("click", close);
  // 開いたまま行き止まりにしない（D-071）。Esc でも閉じる
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) close(); });

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".spot-pick");
    if (!row) return;
    close();
    if (row.dataset.id === selected?.id) return;   // 同じ場所なら何もしない
    const chosen = spots.find((s) => s.id === row.dataset.id);
    if (chosen) onPick(chosen);
  });

  return { close };
}

/**
 * 地名の検索欄を作る。スポットを作れる画面が 2 つある（マップ画面と釣果入力）ので、
 * 見た目も挙動も 1 か所で持つ。
 * @param {HTMLElement} container 中身は差し替える
 * @param {(hit: {name: string, lat: number, lng: number}) => void} onPick
 */
export function attachPlaceSearch(container, onPick) {
  container.classList.add("place-search");
  container.innerHTML = `
    <div class="place-search-row">
      <input type="search" class="place-query" enterkeyhint="search" maxlength="120"
             placeholder="地名・施設名・住所・地図の URL" aria-label="地名・施設名・住所・地図の URL で探す">
      <button type="button" class="chip place-go">探す</button>
    </div>
    <!-- 逃げ道は困る前から見せておく。管理釣り場や小さな池は、
         どの地名データにも載っていないことがある（D-070） -->
    <p class="place-hint">見つからないときは Google マップの URL を貼り付けても探せます。</p>
    <div class="place-hits" hidden role="listbox"></div>`;

  const input = container.querySelector(".place-query");
  const hits = container.querySelector(".place-hits");

  /** 候補も知らせも、出したら必ず閉じられるようにする（D-071）。 */
  function closeHits() {
    hits.hidden = true;
    hits.innerHTML = "";
  }

  // 知らせには閉じるボタンを付ける。
  // 「見つかりませんでした」が出しっぱなしになり、消し方が無かった
  const note = (html) => {
    hits.innerHTML = `<div class="place-note">
        <p>${html}</p>
        <button type="button" class="icon-btn place-close" aria-label="閉じる"
          >${icon("close", { size: 14 })}</button>
      </div>`;
    hits.hidden = false;
    hits.querySelector(".place-close").addEventListener("click", closeHits);
  };

  // 貼り付けの案内。地名検索が使えないときはこれだけが頼りになるので、手順まで書く
  const PASTE_HELP = "Google マップで場所を開き、共有 → リンクをコピーして"
    + "ここに貼り付けても登録できます（「34.7108, 137.5972」のような座標でも構いません）。";

  function choose(hit) {
    closeHits();
    onPick(hit);
  }

  async function run() {
    const text = input.value.trim();
    if (!text) return;

    // 座標・URL なら通信しない。地名検索が落ちていても、この道は必ず通る
    const point = parseLatLng(text);
    if (point) {
      if (!isCoordinateInJapan(point.lat, point.lng)) {
        return note("日本の範囲から外れています。緯度と経度が逆になっていないか確かめてください。");
      }
      return choose({ name: "", lat: point.lat, lng: point.lng });
    }
    if (isShortMapLink(text)) {
      note("リンクを開いています…");
      try {
        const hit = await resolveMapLink(text);
        choose({ name: hit.name ?? "", lat: hit.lat, lng: hit.lng });
        // 住所から求めた位置は施設そのものではない。黙って置くと、
        // 「ここでいい」と思ったまま登録されてしまう
        if (hit.approximate) {
          note(`${escapeHtml(hit.address ?? "住所")}のあたりに置きました。`
            + "<br>このリンクには座標が入っていなかったので、"
            + "<strong>住所から求めたおおよその位置</strong>です。"
            + "地図をタップして正しい場所に直してください。");
        }
      } catch (error) {
        note(escapeHtml(toJapaneseError(error))
          + "<br>一度ブラウザで開いて、表示された長い URL を貼り付けてください。");
      }
      return;
    }

    note("探しています…");
    try {
      const found = await searchPlace(text);
      if (!found.length) {
        // 行き止まりにしない。探した言葉のまま Google マップへ送り、
        // そこで開いた URL を貼り戻してもらう（管理釣り場はここが現実的な唯一の道）
        return note(`「${escapeHtml(text)}」は見つかりませんでした。<br>${PASTE_HELP}`
          + `<br><a class="place-external" target="_blank" rel="noopener"
                 href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}"
               >${icon("map", { size: 13 })} Google マップでこの名前を探す</a>`);
      }
      hits.innerHTML = found.map((hit, i) => `
        <button type="button" class="place-hit" data-i="${i}" role="option">
          ${icon("map-pin", { size: 13 })}
          <span class="place-hit-body">
            <span class="place-hit-name">${escapeHtml(hit.name)}</span>
            ${hit.detail ? `<span class="place-hit-detail">${escapeHtml(hit.detail)}</span>` : ""}
          </span>
        </button>`).join("")
        // 出典。地図タイルの「国土地理院」は Leaflet 側が出しているが、
        // ここに並ぶ地名は OpenStreetMap のものも混ざるので、出た画面で断る
        + `<p class="place-credit">地名検索: 国土地理院 /
             <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener"
               >OpenStreetMap</a> contributors</p>`;
      hits.hidden = false;
      hits.querySelectorAll(".place-hit").forEach((button) => {
        button.addEventListener("click", () => choose(found[Number(button.dataset.i)]));
      });
    } catch (error) {
      note(error instanceof PlaceSearchUnavailable
        ? `地名で探せませんでした。<br>${PASTE_HELP}`
        : escapeHtml(toJapaneseError(error)));
    }
  }

  // 入力し直したら消える（次に探すつもりなら、前の知らせはもう用済み）
  input.addEventListener("input", closeHits);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHits(); });
  // 画面の他の場所を触っても消える
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) closeHits();
  });

  container.querySelector(".place-go").addEventListener("click", run);
  input.addEventListener("keydown", (e) => {
    // このページには別の form があるので、Enter がそちらを送信しないように止める
    if (e.key === "Enter") { e.preventDefault(); run(); }
  });
  return { input, run };
}

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
  /* **ピンの中身は立ち位置、色は種別**（D-101）。
     もとは中身も色も種別で、同じ情報を 2 回描いていた。おかげで
     「二瀬橋」と「二瀬橋(ウェーディング)」が地図上で見分けられなかった
     （同じ河川なので当然だった）。中身を立ち位置に譲れば、
     色で種別・形で立ち位置と、1 つのピンで 2 つ読める。
     凡例は色を説明しているので、色は動かさないこと。
     立ち位置が未設定なら、これまでどおり種別の形にする。 */
  const entry = entryStyle(spot.entry_style);
  const warn = spot.low_tide_only
    ? `<span class="pin-warn">${icon("warning", { size: 13 })}</span>` : "";
  const name = label && spot.name
    ? `<span class="pin-label">${escapeHtml(spot.name)}</span>` : "";
  return L.divIcon({
    className: "spot-pin-wrap",
    html: `<span class="spot-pin" style="--pin:${type.color}">`
        + `${icon(entry?.iconName ?? type.iconName, { size: 14 })}${warn}</span>${name}`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

/* ================================================================
   傾向（SCR-018・D-102）

   **この画面で出せるのは「釣れたときに何が揃っていたか」だけ。**
   「この条件だと釣れる」は言えない。釣れなかった釣行が記録されていないので、
   比べる相手（分母）が無い。ここを混同すると、いちばん記録の多い条件を
   「いちばん良い条件」と読んでしまう。

   ひとつだけ補正できるのが潮回りで、暦のほうの日数が偏っている
   （中潮は月に 11 日あるが、長潮は 2 日しかない）。日数で割れば
   「機会に対してどれだけ出ているか」に近づく。ほかの軸にこの補正は無い。
   ================================================================ */

/* TIME_BANDS と timeBandOf は釣行スコアと共通なので、マヅメの節に置いてある
   （D-103）。別々に持つと、同じ 1 回の釣行が画面によって時間帯が変わる。 */

/**
 * 件数を数える。**null は数えない**（「未入力」と「その値だった」は別物）。
 * 未入力の数は分母と比べれば分かるので、呼ぶ側で出す。
 * @param {object[]} rows
 * @param {(row:object)=>string|null|undefined} keyOf
 * @returns {{key:string, n:number}[]} 多い順。同数なら key の順で安定させる
 */
export function tally(rows, keyOf) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const key = keyOf(row);
    if (key == null || key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => (b.n - a.n) || String(a.key).localeCompare(String(b.key), "ja"));
}

/**
 * 期間内に各潮回りが何日あったか。**釣行の偏りと暦の偏りを分けるため**に使う。
 * 中潮の記録が多いのは、中潮の日が多いだけかもしれない。
 * @param {string} fromIso  "YYYY-MM-DD"（含む）
 * @param {string} toIso    "YYYY-MM-DD"（含む）
 * @param {(iso:string)=>string} typeOf  日付 → 潮回り（tideType を渡す）
 * @returns {Record<string, number>}
 */
export function tideTypeDays(fromIso, toIso, typeOf) {
  const out = {};
  if (!fromIso || !toIso || fromIso > toIso) return out;
  // 日付は UTC 正午で進める。JST の日付文字列をそのまま扱いたいので、
  // 夏時間もタイムゾーンも挟まない形にする
  const day = 86400000;
  let t = Date.parse(`${fromIso}T12:00:00Z`);
  const end = Date.parse(`${toIso}T12:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return out;
  while (t <= end) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const type = typeOf(iso);
    if (type) out[type] = (out[type] ?? 0) + 1;
    t += day;
  }
  return out;
}

/* ================================================================
   釣行時の天気を残す（D-103）

   **あとから取り直せない。** Open-Meteo の予報は過去 3 か月ほどしか遡れず、
   それも別の API になる。記録した時点で残しておかないと、
   「雨の日に出ている」「北風だと渋い」は永久に分からないままになる。
   実際、これを入れるまでの 17 件は weather_snapshot が全部 NULL だった。

   **保存を止めない。** 圏外でも記録は残るのが先（D-096）。
   天気が取れなければ、天気だけ入らないまま保存する。
   ================================================================ */

/**
 * その釣行の時刻の天気を 1 件ぶんの形にして返す。取れなければ null。
 * @param {{lat:number, lng:number, date:string, time:string|null}} at
 */
export async function captureWeatherSnapshot({ lat, lng, date, time }) {
  // 時刻が無ければ残さない。この機能の値打ちは「その時刻の」天気なので、
  // 12 時で代表させると、あとで見たときに本物と区別が付かなくなる
  if (!time || !date || !isCoordinateInJapan(lat, lng)) return null;
  let forecast;
  try {
    forecast = await fetchWeather(lat, lng, date);
  } catch {
    return null;                       // 圏外・予報範囲外。記録の保存は続ける
  }
  const row = forecastHourAt(forecast?.hours, time, date);
  if (!row) return null;

  const sun = forecast.sun ?? null;
  return {
    source: "open-meteo",
    captured_at: new Date().toISOString(),
    for_time: String(time).slice(0, 5),   // 釣行の時刻
    at: `${String(row.hour).padStart(2, "0")}:00`,   // 実際に使った予報の時刻
    weather_code: row.weather_code ?? null,
    wind_speed_ms: row.wind_speed_ms ?? null,
    wind_dir_deg: row.wind_dir_deg ?? null,
    /* 突風と予想雨量も残す（D-104）。あとから取り直せないのは同じなので、
       取れるようになった時点で一緒に入れておく。
       降水確率は入れない（D-111。気象庁の値ではなかったので出すのをやめた）。
       前に保存した記録には残っているので、読むほうは受け付ける */
    precip_mm: row.precip_mm ?? null,
    wind_gust_ms: row.wind_gust_ms ?? null,
    temp_c: row.temp_c ?? null,
    wave_height_m: row.wave_height_m ?? null,
    band: timeBandOf(sun, time),
    sunrise: sun?.rise ?? null,
    sunset: sun?.set ?? null,
  };
}

/** 保存した天気を 1 行の文にする。無ければ null。 */
export function weatherSnapshotText(snapshot) {
  if (!snapshot) return null;
  const parts = [];
  if (snapshot.weather_code != null) parts.push(describeWeather(snapshot.weather_code).label);
  if (snapshot.wind_dir_deg != null && snapshot.wind_speed_ms != null) {
    parts.push(`${windDirection(snapshot.wind_dir_deg)} ${Number(snapshot.wind_speed_ms).toFixed(1)}m/s`
      + (snapshot.wind_gust_ms != null ? `（突風 ${Math.round(snapshot.wind_gust_ms)}）` : ""));
  }
  // 予想雨量。古い記録には降水確率しか無いので、そちらも読めるようにしておく（D-111）
  if (snapshot.precip_mm != null) parts.push(`雨 ${Number(snapshot.precip_mm).toFixed(1)}mm/h`);
  else if (snapshot.precip_chance != null) parts.push(`降水 ${snapshot.precip_chance}%`);
  if (snapshot.temp_c != null) parts.push(`${Math.round(snapshot.temp_c)}℃`);
  if (snapshot.wave_height_m != null) parts.push(`波 ${snapshot.wave_height_m}m`);
  return parts.length ? parts.join(" / ") : null;
}

/* ================================================================
   1 時間ごとの予報の読み方（D-104）

   「雨が降るのか」「風はどうか」を、天気記号から推し量らずに済むようにする。
   ================================================================ */

/**
 * 風向きの矢印を何度まわすか。
 *
 * **予報の風向は「風が吹いてくる方角」**（気象の約束）。
 * 矢印は「吹いていく向き」に倒すのが天気の画面の慣例なので **180 度足す**。
 *   北風（0°）＝北から南へ吹く → 矢印は下（180°）
 *   西風（270°）＝西から東へ吹く → 矢印は右（90°）
 * ここを取り違えると、**画面は正常に見えるのに向きだけ真逆**になる。
 * 文字（北西など）は吹いてくる方角のまま出すので、並べても矛盾しない。
 */
export function windArrowDeg(fromDegrees) {
  // Number(null) も Number("") も 0 になる。0 は「北風」という有効な値なので、
  // ここで弾かないと **風向が無い時間に真下向きの矢印が出る**（D-056 と同じ罠）
  if (fromDegrees == null || fromDegrees === "") return null;
  const deg = Number(fromDegrees);
  if (!Number.isFinite(deg)) return null;
  return ((deg + 180) % 360 + 360) % 360;
}

/** 風の強さの区切り。**釣行スコアと同じ数字**を使う（別々にすると説明が食い違う）。 */
export function windLevel(ms) {
  if (ms == null || ms === "") return null;   // 0 は「無風」という有効な値
  const v = Number(ms);
  if (!Number.isFinite(v)) return null;
  if (v > 10) return { key: "danger", label: "強すぎ" };   // スコア 2 点以下
  if (v > 7) return { key: "strong", label: "強い" };      // スコア 4 点の上限
  if (v > 5) return { key: "fresh", label: "やや強い" };   // スコア 5 点の上限
  return { key: "calm", label: "穏やか" };
}

/** 予想雨量（mm/h）の段階（D-111）。前は降水確率で分けていた。
    区切りは気象庁の雨の強さの言い方に寄せてある。0 は有効な値なので null と分ける。 */
export function rainLevel(mm) {
  if (mm == null || mm === "") return null;
  const v = Number(mm);
  if (!Number.isFinite(v)) return null;
  if (v >= 10) return { key: "high", label: "強い雨" };
  if (v >= 3)  return { key: "mid",  label: "雨" };
  if (v >= 0.1) return { key: "low", label: "弱い雨" };
  return { key: "none", label: "降らない" };
}

/** 時間別天気のカード 1 枚の幅と間隔（px）。**theme.css の .hour-card / .hourly と揃える。**
    日付の帯の幅をここから計算するので、片方だけ変えると帯とカードがずれる（D-112）。 */
const HOUR_CARD_W = 54;
const HOUR_CARD_GAP = 8;

/** 雨が「降っている」と言える降水量（mm/h）。これ未満は量として意味がない。 */
const RAIN_MM = 0.1;
/** **これから降り出す**と見出しに書くのに要る量（mm）。いま降っている判定には使わない。
    1 時間だけ 0.2mm のような予想で「雨になりそう」と言うと、外に出るのをやめてしまう。 */
const RAIN_WORTH_MM = 0.5;

/**
 * その日 1 日を代表する天気（D-130）。週間カレンダーの 1 マスに 1 つだけ出す。
 *
 * **12 時の 1 時間で代表させない。** 前はそうしていて、夜に雨が来る日でも
 * 週カレンダーは晴れのままだった。同じ画面の見出しは
 * 「21時ごろから雨になりそうです」と書いているのに、カレンダーは晴れ、という
 * 食い違いが実際に出ていた（本人の指摘）。
 *
 * 順番は **雷 → 雨 → 曇り → 晴れ**。釣行の判断がいちばん変わるものを上に置く。
 *
 * 雨の物差しは `rainOutlook` の見出しと**同じもの**を使う（2 時間続くか、
 * 0.5mm/h 以上あるか）。**片方だけ緩めると、見出しは「少し降るかも」なのに
 * カレンダーは雨、という新しい食い違いを作ることになる。**
 *
 * 返すのは**実際にあった時間の WMO コード**。区分に丸めて 61 を返すと、
 * 霧雨の日も本降りの日も同じアイコンになる。
 *
 * @param {object[]} hours その日 24 時間ぶんの予報
 * @returns {number|null} アイコンに使う WMO コード
 */
export function dayWeatherCode(hours) {
  const rows = (hours ?? []).filter((h) => h?.weather_code != null);
  if (!rows.length) return null;

  // 雷は 1 時間でもその日の顔になる
  const storm = rows.filter((h) => h.weather_code >= 95);
  if (storm.length) return commonest(storm.map((h) => h.weather_code));

  /* 「見出しに書ける雨」があるか。2 時間続くか、まとまった量が 1 時間でもあるか */
  let run = 0, rainy = false;
  for (const h of rows) {
    const wet = (h.precip_mm ?? 0) >= RAIN_MM;
    run = wet ? run + 1 : 0;
    if (run >= 2 || (wet && h.precip_mm >= RAIN_WORTH_MM)) { rainy = true; break; }
  }
  if (rainy) {
    // いちばん強く降る時間の顔を使う。無ければ雨の総称（61）
    const wetRows = rows.filter((h) => (h.precip_mm ?? 0) >= RAIN_MM
      && weatherCategory(h.weather_code) === "rain");
    if (!wetRows.length) return 61;
    return wetRows.reduce((a, b) => (b.precip_mm > a.precip_mm ? b : a)).weather_code;
  }

  const cloudy = rows.filter((h) => weatherCategory(h.weather_code) === "cloudy");
  // 1 日の 3 分の 1 が曇りなら、その日は「晴れ」ではない
  if (cloudy.length * 3 >= rows.length) return commonest(cloudy.map((h) => h.weather_code));
  return commonest(rows.map((h) => h.weather_code));
}

/** いちばん多い値。同数なら小さいほう（晴れ寄り）を選ぶ。 */
function commonest(values) {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0][0];
}

/**
 * これから先の雨を 1 行にまとめる（D-104 / D-107 / D-111）。
 * **時間ごとの数字を並べる前に、結論を先に出す。**
 * 24 個の数字を目で追って「何時から雨か」を組み立てるのは、その場でやりたくない。
 *
 * **見るのは予想雨量（mm）だけ**（D-111）。降水確率は気象庁が返さず、
 * 出していた値は別モデルのものだった（同じ時刻で ICON 0% / GFS 25% / ECMWF 85%）ので
 * 表示ごとやめた。
 *
 * **「いま降っています」とは書かない**（D-111）。1 時間ぶんの予想雨量から
 * 現在を断定はできない。実際、16 時台に降って 17 時前に上がった雨を
 * 17:09 に「いま雨が降っています」と書いて外した。時間帯の予報として書く。
 *
 * @param {object[]} hours 時刻順に並んだ予報（これから先のぶん）
 * @param {boolean}  startsNow 先頭が「いまの時間帯」か。今日を今から並べたときだけ true
 * @returns {{key:string, text:string, from:object|null, until:object|null,
 *            heaviest:object|null}|null}
 */
export function rainOutlook(hours, { startsNow = false } = {}) {
  const rows = (hours ?? []).filter((h) => h?.precip_mm != null);
  if (!rows.length) return null;

  const hh = (h) => `${h.hour}時`;
  const mm = (h) => `${Number(h.precip_mm).toFixed(1)}mm/h`;
  const wet = (h) => h.precip_mm >= RAIN_MM;
  const heaviest = rows.reduce((a, b) => (b.precip_mm > a.precip_mm ? b : a));

  /* 雨の続きを頭から拾う。**降り止む時刻まで一組で持つ**（D-107）。
     いつ降り出すかを言うにも、いつやむかを言うにも同じものが要る */
  const runs = [];
  for (let i = 0; i < rows.length; i++) {
    if (!wet(rows[i])) continue;
    let j = i;
    while (j + 1 < rows.length && wet(rows[j + 1])) j++;
    runs.push({
      from: rows[i], startIndex: i,
      until: j + 1 < rows.length ? rows[j + 1] : null,   // 窓の端まで続くなら null
      heaviest: rows.slice(i, j + 1).reduce((a, b) => (b.precip_mm > a.precip_mm ? b : a)),
      length: j - i + 1,
    });
    i = j;
  }

  /* いまの時間帯が雨なら、始まりではなく**終わり**を知りたい。
     ただし「いま降っている」ではなく「この時間帯は雨の予想」と書く */
  const nowRun = startsNow && runs[0]?.startIndex === 0 ? runs[0] : null;
  if (nowRun) {
    return { key: "rain", heaviest, from: nowRun.from, until: nowRun.until,
             text: `${hh(rows[0])}台は雨の予想です（${mm(rows[0])}）。`
               + (nowRun.until
                    ? `${hh(nowRun.until)}ごろにやみそうです`
                    : `この先 ${rows.length} 時間降り続きそうです`) };
  }

  /* **1 時間だけの弱い雨で見出しを出さない。**
     2 時間以上続くか、まとまった量があるものだけ「降り出す」と書く */
  const worth = runs.find((r) => r.length >= 2 || r.heaviest.precip_mm >= RAIN_WORTH_MM);
  if (worth) {
    return { key: "rain", heaviest, from: worth.from, until: worth.until,
             text: `${hh(worth.from)}ごろから雨になりそうです`
               + (worth.until ? `（${hh(worth.until)}ごろまで・最大 ${mm(worth.heaviest)}）`
                              : `（最大 ${mm(worth.heaviest)}）`) };
  }

  /* ぱらつく程度の予想はある。降ると言い切らず、そう書く */
  if (runs.length) {
    return { key: "maybe", heaviest, from: runs[0].from, until: null,
             text: `${hh(runs[0].from)}ごろに少し降るかもしれません（${mm(runs[0].heaviest)}）` };
  }

  return { key: "none", heaviest, from: null, until: null,
           text: `この先 ${rows.length} 時間、雨の予想はありません` };
}

/**
 * 同じ時刻の行が 2 度来ていたら 1 つにまとめる（D-114）。
 *
 * 週まとめの予報（fetchWeatherRange）は日ごとに切ってあり、
 * **各日の末尾に翌日 0 時を足してある**（その日のグラフを 24 時まで引くため）。
 * 潮汐詳細はそこへ翌日ぶんをつなげて渡すので、**0 時が 2 枚並ぶ**。
 * その 1 枚に押し出されて、21 時に見ると 24 枚目が 19 時になっていた（本人の指摘）。
 *
 * つなげる側で削るのではなく、**受け取る側でまとめる**。
 * 「日ごとの配列を並べて渡してよい」という渡し方をそのまま活かしたいのと、
 * 削る位置を数えるやり方は日数が変わると黙って狂うため。
 */
export function uniqueHours(rows) {
  const seen = new Set();
  return (rows ?? []).filter((row) => {
    const key = String(row?.time).slice(0, 13);      // "YYYY-MM-DDTHH"
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * これから先の予報を、いまの時刻から順に取り出す（D-104）。
 * 予報は 0 時からの並びなので、そのまま出すと**すでに過ぎた時間**が先頭に来る。
 * 同じ時刻が重なっていると 1 枚ぶん足りなくなるので、先に uniqueHours を通すこと。
 * @param {object[]} hours 2 日ぶんの予報
 * @param {string} nowIso  いまの時刻（"YYYY-MM-DDTHH:MM" の形。JST）
 */
export function hoursFromNow(hours, nowIso, count = 24) {
  if (!hours?.length || !nowIso) return [];
  const from = String(nowIso).slice(0, 13);   // "YYYY-MM-DDTHH"
  const start = hours.findIndex((h) => String(h.time).slice(0, 13) >= from);
  /* **見つからない＝予報の範囲より先**。ここで先頭に落とすと、
     すでに過ぎた時間の予報を「これから」として並べてしまう。何も出さない。
     逆に、いまが予報より前（範囲全部が未来）なら findIndex が 0 を返す */
  if (start < 0) return [];
  return hours.slice(start, start + count);
}

/**
 * 時間別天気の帯を描く（D-104 / D-105）。**ホームと潮汐詳細で同じものを使う。**
 *
 * もとはホームと潮汐詳細に同じ描画が 2 本あった。片方（ホーム）だけ 1 時間ごとに
 * 直した結果、潮汐詳細は 3 時間刻みのまま取り残され、マヅメの印も
 * 「6 時と 18 時」の決め打ちで、気温が欠けた時間には NaN° と出ていた。
 * **2 本あることが原因なので 1 本にする。**
 *
 * @param {HTMLElement} box 帯を入れる箱
 * @param {object}  opt
 * @param {object[]|null} opt.hours 予報（2 日ぶんでもよい）
 * @param {string}  opt.date 見せたい日（"YYYY-MM-DD"）
 * @param {HTMLElement|null} opt.leadBox 雨の要約を出す箱。省くと出さない
 * @param {string}  opt.emptyText 予報が無いときの文言
 * @param {((row:object)=>number|null)|null} opt.scoreOf
 *   1 時間ごとの釣行スコア（D-116）。渡すとカードに★を出す。
 *   前は時間帯 4 つの並びを別に置いていたが、**同じことを 2 か所で言っていた**うえ、
 *   時間帯の点は「その帯でいちばん良い 1 時間」なので、
 *   **帯の中のどこが良いのかが消えていた**（1 日の中で 2〜5 に散る）。
 */
export function renderHourlyStrip(box, {
  hours, date = null, leadBox = null, count = 24,
  emptyText = "予報がありません", scoreOf = null,
} = {}) {
  const hide = (text) => {
    box.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
    if (leadBox) leadBox.hidden = true;
  };
  if (!hours?.length) return hide(emptyText);

  // 日ごとの配列をつないで渡されることがあり、境目の 0 時が重なる（D-114）
  const series = uniqueHours(hours);

  /* **今日はいまの時刻から、先の日は 0 時から。**
     予報は 0 時からの並びなので、今日をそのまま出すと過ぎた時間が先頭に来る。
     逆に明日以降を「いまの時刻から」にすると、その日の朝が消えてしまう。 */
  const today = todayInJst();
  const now = nowInJst();
  const startsNow = !date || date === today;
  const rows = startsNow
    ? hoursFromNow(series, `${now.date}T${now.hhmm}`, count)
    : hoursOfDate(series, date).slice(0, count);
  if (!rows.length) return hide(emptyText);

  if (leadBox) {
    /* 先頭が「いまの時間帯」かを渡す（D-107）。
       これを渡さないと、いま 12:05 なのに「12 時ごろから雨になりそうです」と出る */
    const outlook = rainOutlook(rows, { startsNow: startsNow && rows[0].hour === now.hour });
    leadBox.hidden = !outlook;
    if (outlook) {
      leadBox.className = `hourly-lead ${outlook.key}`;
      leadBox.innerHTML = `${icon(outlook.key === "none" ? "sun" : "rain", { size: 14 })}`
        + `<span>${escapeHtml(outlook.text)}</span>`;
    }
  }

  /* 色を付けるのは**いまの時間**（D-117）。
     前はマヅメ（日の出・日没の時間）に色を付けていたが、
     **いまどこを見ているのかが分からない**ほうが困る、という本人の指摘。
     マヅメが良い時間かどうかは★が言うので、印を重ねる必要も無くなった。
     先の日を見ているときは「いま」が窓の中に無いので、どこにも色は付かない。 */
  /* **now.hour（整数）を使う。** now.hours は `hour + minute/60` の小数で、
     8:35 なら 8.5833… になる。padStart しても "2026-08-14T8.5833…" にしかならず、
     **どのカードにも一致せず、色が付かないまま静かに通る。** 1 度これで落とした。 */
  const nowHour = startsNow ? `${now.date}T${String(now.hour).padStart(2, "0")}` : null;

  /* 日付は**カードの上を横に走る帯**として出す（D-112）。
     その日のカードのぶんだけ幅を持ち、日が変わるところで区切れる。
     前は日付を時刻と同じ行に入れていて（「13日 0時」）、54px に収まらず
     そこだけ 2 行になり、その 1 枚だけ中身が下にずれていた。

     幅はカードの並びから計算する（1 枚 54px・間隔 8px。theme.css と揃えること）。
     帯とカードを同じ横スクロールの中に入れて、ずれないようにする。 */
  const days = [];
  for (const w of rows) {
    const date = String(w.time).slice(0, 10);
    if (days.at(-1)?.date === date) days.at(-1).count += 1;
    else days.push({ date, count: 1 });
  }
  const ruler = days.map(({ date, count }) => {
    const width = count * HOUR_CARD_W + (count - 1) * HOUR_CARD_GAP;
    /* 中の名前は横スクロールに貼り付く（position: sticky）。
       真ん中に置くと、少しスクロールしただけで日付が画面の外へ出てしまう。
       貼り付けておけば、**いま見ている日の名前が常に見えている。** */
    return `<span class="day-seg${date === today ? " today" : ""}" style="width:${width}px"
                 ><span class="day-name">${escapeHtml(formatJstDate(date, { weekday: true }))}</span></span>`;
  }).join("");

  const cards = rows.map((w, i) => {
    const { icon: weatherIcon } = describeWeather(w.weather_code);
    const rain = rainLevel(w.precip_mm);
    const wind = windLevel(w.wind_speed_ms);
    const arrow = windArrowDeg(w.wind_dir_deg);
    const isNow = nowHour != null && String(w.time).slice(0, 13) === nowHour;
    const newDay = i > 0 && String(w.time).slice(0, 10) !== String(rows[i - 1].time).slice(0, 10);
    /* 釣行スコア（D-116）。**時刻のすぐ下**に置く。
       横に流しながら「何時が良いか」を読むので、時刻と点が離れていると
       目を上下に往復させることになる。色は週間カレンダーの★と同じ規則。 */
    const score = scoreOf ? scoreOf(w) : null;
    return `
      <div class="hour-card${isNow ? " now" : ""}${newDay ? " newday" : ""}">
        <div class="h">${w.hour}時</div>
        ${score ? `<div class="sc sc-${score}">${stars(score, { html: true })}</div>` : ""}
        <div class="icon-wrap">${weatherIcon}</div>
        <!-- 降水確率ではなく**予想雨量**を出す（D-111）。
             確率は気象庁が返さず、出していた値は別モデルのものだった。
             0.0 は「降らない」なので「—」（値が無い）とは分けて書く -->
        <div class="pop ${rain?.key ?? "unknown"}">${
          w.precip_mm == null ? "—"
            : w.precip_mm < 0.1 ? `0<span class="pct">mm</span>`
            : `${Number(w.precip_mm).toFixed(1)}<span class="pct">mm</span>`}</div>
        <div class="t">${w.temp_c != null ? `${Math.round(w.temp_c)}°` : "—"}</div>
        <div class="wind wnd-${wind?.key ?? "unknown"}">
          ${arrow != null
            ? `<span class="wind-arrow" style="transform:rotate(${arrow}deg)"
                     title="${escapeHtml(windDirection(w.wind_dir_deg))}の風">${
                 icon("wind-arrow", { size: 12 })}</span>`
            : ""}
          <!-- 単位を添える（本人の指摘）。数字だけだと m/s か km/h か分からない -->
          <span class="ms">${w.wind_speed_ms != null
            ? `${Number(w.wind_speed_ms).toFixed(1)}<small>m/s</small>` : "—"}</span>
        </div>
        <!-- 「突」だけでは何の略か伝わらない。**最大**（その 1 時間で瞬間的に
             いちばん強かった風。Open-Meteo の定義もその 1 時間の最大値）と書く -->
        <div class="gust">${w.wind_gust_ms != null
          ? `最大${Math.round(w.wind_gust_ms)}<small>m/s</small>` : "&nbsp;"}</div>
      </div>`;
  }).join("");

  box.innerHTML = `<div class="hourly-inner">`
    + `<div class="hourly-days">${ruler}</div>`
    + `<div class="hourly-row">${cards}</div>`
    + `</div>`;
}
