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

export async function fetchTide(station, date) {
  const url = `${config.supabaseUrl}/functions/v1/tide`
    + `?station=${encodeURIComponent(station)}&date=${encodeURIComponent(date)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`潮汐データを取得できませんでした (${response.status})`);
  return response.json();
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
    + "&hourly=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms"
    + "&daily=sunrise,sunset";
  const marineUrl = "https://marine-api.open-meteo.com/v1/marine?" + base + "&hourly=wave_height";

  const [forecastRes, marineRes] = await Promise.all([
    fetch(forecastUrl),
    fetch(marineUrl).catch(() => null),
  ]);
  if (!forecastRes.ok) throw new Error(`天気データを取得できませんでした (${forecastRes.status})`);

  const forecast = await forecastRes.json();
  let waves = null;
  if (marineRes && marineRes.ok) {
    const marine = await marineRes.json();
    waves = marine.hourly?.wave_height ?? null;
  }

  const h = forecast.hourly;
  const hours = h.time.map((time, i) => ({
    time,
    hour: Number(time.slice(11, 13)),
    temp_c: h.temperature_2m[i],
    weather_code: h.weather_code[i],
    wind_speed_ms: h.wind_speed_10m[i],
    wind_dir_deg: h.wind_direction_10m[i],
    wave_height_m: waves ? waves[i] : null,
  }));

  // daily は start_date から並ぶので 0 番目が対象日。値は "YYYY-MM-DDTHH:MM"（JST）
  const daily = forecast.daily ?? {};
  const rise = daily.sunrise?.[0]?.slice(11, 16) ?? null;
  const set = daily.sunset?.[0]?.slice(11, 16) ?? null;
  return { hours, sun: rise && set ? { rise, set } : null };
}

/** "HH:MM" を小数の時刻に変換する（グラフの横位置計算用）。 */
export function hoursFromHhmm(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : null;
}

/* ---------------- 釣行スコア（設計補完書 7 章・D-018） ---------------- */

export function fishingScore(tideType, weatherCode, windMs) {
  const weather = weatherCategory(weatherCode);
  if (weather === "storm" || windMs >= 15) return 1;
  if (weather === "rain" || windMs > 10) return 2;
  const fine = weather === "sunny" || weather === "cloudy";
  if (tideType === "大潮" && fine && windMs <= 5) return 5;
  if (tideType === "中潮" && fine && windMs <= 7) return 4;
  return 3;
}

/* ---------------- データアクセス ---------------- */

export async function currentUserId() {
  const { data } = await client.auth.getUser();
  return data.user?.id ?? null;
}

export async function listSpots() {
  const { data, error } = await client
    .from("spots")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function listRecords({ limit = 50, spotId = null } = {}) {
  let query = client
    .from("fishing_records")
    .select("*, spots(name, water_type), lure_recipes(name), fish_species(name)")
    .order("fished_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (spotId) query = query.eq("spot_id", spotId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * 一覧に出す魚の名前。出世魚の呼称があればそれを、なければ魚種名を使う。
 * 呼称ルールを持たない魚種（アジ・カサゴなど）でも名前が出るようにする。
 */
export function recordFishName(record) {
  return record.fish_name_local ?? record.fish_species?.name ?? "釣果";
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

/** ボトムナビを描画する。current は home / map / records / recipes / groups。 */
export function renderNav(current) {
  const items = [
    ["home", "index.html", "home", "ホーム"],
    ["map", "spots.html", "map", "マップ"],
    ["records", "records.html", "records", "釣果"],
    ["recipes", "recipes.html", "recipes", "レシピ"],
    ["groups", "#", "groups", "グループ"],
  ];
  document.body.insertAdjacentHTML("beforeend", `
    <nav class="bottom-nav">
      ${items.map(([key, href, iconName, label]) => `
        <a class="nav-item${key === current ? " active" : ""}"
           href="${href}"${href === "#" ? ' aria-disabled="true"' : ""}>
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

/* ---------------- ルアーカテゴリ（確定仕様書 2.1・9.1 章） ---------------- */

export const LURE_CATEGORIES = [
  { value: "area",  label: "エリア", subs: ["スプーン", "クランク（エリア）", "プラグ（エリア）"] },
  { value: "hard",  label: "ハード", subs: ["ミノー", "シンペン", "ポッパー", "ペンシル", "バイブ", "クランク", "シャッド", "スイムベイト"] },
  { value: "metal", label: "メタル", subs: ["ジグ", "ジグヘッド", "スピンテール", "メタルバイブ"] },
  { value: "soft",  label: "ソフト", subs: ["ワーム", "グラブ", "シャッドテール", "チューブ"] },
  { value: "egi",   label: "エギ",   subs: ["エギ", "タコエギ"] },
  { value: "other", label: "その他", subs: ["その他"] },
];

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

export const SPOT_TYPES = [
  { value: "surf",    label: "サーフ",   color: "#4A9ECC", iconName: "surf" },
  { value: "rock",    label: "磯",       color: "#4CAF50", iconName: "rock" },
  { value: "port",    label: "港湾",     color: "#C9A84C", iconName: "port" },
  { value: "managed", label: "管理釣り場", color: "#4CAF50", iconName: "managed" },
  { value: "river",   label: "河川",     color: "#6E9ECF", iconName: "river" },
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
export function createMap(element, { center = DEFAULT_MAP_CENTER, zoom = DEFAULT_MAP_ZOOM } = {}) {
  const map = L.map(element, { center, zoom, zoomControl: true, attributionControl: true });
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
  return { map, layers, current: "pale" };
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
