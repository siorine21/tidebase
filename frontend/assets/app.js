/* TIDEBASE 共通クライアント（認証・API アクセス・共通ロジック）。
   データアクセスは PostgREST + RLS、潮汐は Edge Function、天気は Open-Meteo（D-013・D-021）。 */

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

/* ---------------- 天気（Open-Meteo・API キー不要） ---------------- */

const WMO = {
  0: ["快晴", "☀️"], 1: ["晴れ", "🌤️"], 2: ["一部曇り", "⛅"], 3: ["曇り", "☁️"],
  45: ["霧", "🌫️"], 48: ["霧", "🌫️"],
  51: ["霧雨", "🌦️"], 53: ["霧雨", "🌦️"], 55: ["霧雨", "🌦️"],
  61: ["小雨", "🌧️"], 63: ["雨", "🌧️"], 65: ["大雨", "🌧️"],
  71: ["雪", "🌨️"], 73: ["雪", "🌨️"], 75: ["大雪", "🌨️"],
  80: ["にわか雨", "🌦️"], 81: ["にわか雨", "🌧️"], 82: ["激しい雨", "🌧️"],
  95: ["雷雨", "⛈️"], 96: ["雷雨", "⛈️"], 99: ["雷雨", "⛈️"],
};

export function describeWeather(code) {
  const [label, icon] = WMO[code] ?? ["—", "🌡️"];
  return { label, icon };
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
 * 指定座標・指定日の 3 時間刻み予報（0時〜24時間後の 9 点）。
 * 波高は海上グリッド外だと null になる（設計補完書 1.1 章）。
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
    .select("*, spots(name, water_type), lure_recipes(name)")
    .order("fished_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (spotId) query = query.eq("spot_id", spotId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function listSpecies() {
  const { data, error } = await client
    .from("fish_species")
    .select("id, name, category, name_rule_group")
    .order("name");
  if (error) throw error;
  return data;
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
    ["home", "index.html", "🏠", "ホーム"],
    ["map", "spots.html", "🗺️", "マップ"],
    ["records", "records.html", "📋", "釣果"],
    ["recipes", "recipes.html", "🎣", "レシピ"],
    ["groups", "#", "👥", "グループ"],
  ];
  document.body.insertAdjacentHTML("beforeend", `
    <nav class="bottom-nav">
      ${items.map(([key, href, icon, label]) => `
        <a class="nav-item${key === current ? " active" : ""}"
           href="${href}"${href === "#" ? ' aria-disabled="true"' : ""}>
          <span class="nav-icon">${icon}</span><span>${label}</span>
        </a>`).join("")}
    </nav>`);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
