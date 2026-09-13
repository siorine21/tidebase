/**
 * 予報が届かない日の天気（D-153）のテスト。
 *   node frontend/tests/weather_archive.test.mjs
 *
 * **ここは「200 なのに空」を見抜くところ。**
 * 予報の API は models を名指しすると、約 55 日より前を
 * **200 を返しながら中身が全部 null** で寄こす。行は時刻の数だけ並ぶので、
 * 件数を見ても気づけない。見落とすと **全部 null の「天気」が記録に残り**、
 * 画面には何も出ないまま「取れなかったのか、本当に無風無降水なのか」が
 * 永久に分からなくなる。
 *
 * 押さえるのは 3 つ。
 *   - 空かどうかは**値で**見る（行数では見ない）
 *   - 空のときだけ過去の実況へ落とす。**ふだんは 1 本も増やさない**
 *   - どちらから来たかを **source に必ず書く**（予報と実況は別のデータ）
 */
import { sliceApp } from './_slice.mjs';

/* 通信は全部差し替える。**どの URL を叩いたか**を見たいので覚えておく */
const prelude = `
  let calls = [];
  let responses = {};     // url の一部 -> () => ({ ok, json })
  function fetchWithTimeout(url) {
    calls.push(url);
    for (const [part, make] of Object.entries(responses)) {
      if (url.includes(part)) {
        const r = make(url);
        return r === null ? Promise.reject(new Error("圏外")) : Promise.resolve(r);
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  }
  function sunTimes() { return { rise: "05:20", set: "18:10" }; }
  function isCoordinateInJapan() { return true; }
  function forecastHourAt(hours) { return (hours ?? [])[0] ?? null; }
  function timeBandOf() { return "day"; }
`;
const code = sliceApp([
  ['const WEATHER_MODELS = "jma_seamless,best_match";', '/**\n * **複数地点**の当日ぶんの時間別予報'],
  'export async function captureWeatherSnapshot',
  'export function weatherSourceNote',
], prelude);

const app = new Function(code + `; return { fetchWeather, forecastIsEmpty,
  captureWeatherSnapshot, weatherSourceNote,
  _calls: () => calls, _reset: (r) => { calls = []; responses = r; } };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/** 時刻を 25 本（翌日 0 時ぶんを含む）。値は fill で作る */
const TIMES = Array.from({ length: 25 }, (_, i) =>
  `2026-07-12T${String(i % 24).padStart(2, '0')}:00`);
const series = (v) => TIMES.map(() => v);
const hourlyBody = (suffix, value) => ({
  time: TIMES,
  [`temperature_2m${suffix}`]: series(value),
  [`weather_code${suffix}`]: series(value === null ? null : 3),
  [`wind_speed_10m${suffix}`]: series(value === null ? null : 4),
  [`wind_direction_10m${suffix}`]: series(value === null ? null : 180),
  [`pressure_msl${suffix}`]: series(value === null ? null : 1008),
  [`precipitation${suffix}`]: series(value === null ? null : 0),
  [`wind_gusts_10m${suffix}`]: series(value === null ? null : 7),
});
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

/* 予報が中身のある値を返す（ふつうの日） */
const LIVE = { hourly: hourlyBody('_jma_seamless', 26.5) };
/* **200 なのに全部 null**（55 日より前の実際の返り） */
const EMPTY = { hourly: hourlyBody('_jma_seamless', null) };
/* 過去の実況。models を付けないので接尾辞は無い */
const ARCHIVE = { hourly: hourlyBody('', 24.0) };

/* ---- 空かどうかは「値」で見る ---- */
check('値があれば空ではない',
  app.forecastIsEmpty([{ temp_c: 20, weather_code: null, wind_speed_ms: null }]) === false);
/* **行はあるのに値が無い。** ここが本番で起きた形 */
check('**行が並んでいても値が無ければ空**',
  app.forecastIsEmpty(Array.from({ length: 24 },
    () => ({ temp_c: null, weather_code: null, wind_speed_ms: null }))) === true);
check('天気記号だけでも空ではない',
  app.forecastIsEmpty([{ temp_c: null, weather_code: 3, wind_speed_ms: null }]) === false);
check('風だけでも空ではない',
  app.forecastIsEmpty([{ temp_c: null, weather_code: null, wind_speed_ms: 2 }]) === false);
check('1 行も無ければ空', app.forecastIsEmpty([]) === true);
check('null でも落ちない', app.forecastIsEmpty(null) === true);
check('行が null 混じりでも落ちない', app.forecastIsEmpty([null, undefined]) === true);

/* ---- ふだんの日：過去の実況は取りに行かない ----
   **ここが増えると、毎回の表示で 1 本ぶん遅くなる** */
{
  app._reset({ 'api.open-meteo.com': () => okJson(LIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  const got = await app.fetchWeather(34.66, 137.9, '2026-09-12');
  eq('予報が取れたら source は予報', got.source, 'open-meteo');
  eq('気温が入る', got.hours[0].temp_c, 26.5);
  check('**過去の実況は叩かない**',
    !app._calls().some((u) => u.includes('archive-api')),
    app._calls().filter((u) => u.includes('archive')).join(' '));
}

/* ---- 予報が空の日：過去の実況へ落とす ---- */
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => okJson(ARCHIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  const got = await app.fetchWeather(34.66, 137.9, '2026-07-12');
  eq('**空だったら過去の実況で埋める**', got.hours[0].temp_c, 24.0);
  eq('source が書き分けられる', got.source, 'open-meteo-archive');
  const archiveCalls = app._calls().filter((u) => u.includes('archive-api'));
  eq('過去の実況は 1 本だけ', archiveCalls.length, 1);
  /* **models を付けない。** 付けるとそのモデルの持ち物しか返らず、
     まさにいま埋めようとしている穴がそのまま残る */
  check('**過去の実況に models は付けない**', !archiveCalls[0].includes('models='),
    archiveCalls[0]);
  check('時間帯の項目も頼んでいる（雨量・突風）',
    archiveCalls[0].includes('precipitation') && archiveCalls[0].includes('wind_gusts_10m'));
  check('風速の単位を m/s で頼んでいる', archiveCalls[0].includes('wind_speed_unit=ms'));
  check('日の出・日没は計算のまま', got.sun.rise === '05:20');
}

/* ---- 過去の実況も取れないとき ----
   **保存を止めない。** 天気が無くても記録が残るほうが先（D-096） */
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => ({ ok: false, status: 400, json: async () => ({}) }) });
  const got = await app.fetchWeather(34.66, 137.9, '2026-01-01');
  check('落ちずに返る', Array.isArray(got.hours));
  eq('空のままなら source は予報のまま', got.source, 'open-meteo');
  check('中身は空のまま', app.forecastIsEmpty(got.hours));
}
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => null });     // 通信そのものが失敗
  const got = await app.fetchWeather(34.66, 137.9, '2026-01-02');
  check('過去の実況が圏外でも落ちない', Array.isArray(got.hours));
}
/* 過去の実況まで空だったとき。**空を空で上書きしない** */
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => okJson({ hourly: hourlyBody('', null) }) });
  const got = await app.fetchWeather(34.66, 137.9, '2026-01-03');
  eq('どちらも空なら source は予報のまま', got.source, 'open-meteo');
}

/* ---- 予報そのものが落ちたときは、これまでどおり投げる ---- */
{
  app._reset({ 'api.open-meteo.com': () => ({ ok: false, status: 500, json: async () => ({}) }) });
  let threw = false;
  try { await app.fetchWeather(34.66, 137.9, '2026-09-01'); } catch { threw = true; }
  check('予報も実況も無ければ投げ返す（これまでどおり）', threw);
}

/* ---- 92 日より前：予報は 400 で**断られる** ----
   **ここが本丸。** 届かない形は 2 つあり、こちらは 200 ですらない。
   先に投げてしまうと、いちばん埋めたい古い日付で実況にたどり着けない */
{
  app._reset({ 'api.open-meteo.com/v1/forecast':
                 () => ({ ok: false, status: 400, json: async () => ({ error: true }) }),
               'archive-api': () => okJson(ARCHIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  let got = null;
  let escaped = null;
  try { got = await app.fetchWeather(34.66, 137.9, '2026-03-08'); }
  catch (e) { escaped = e; }
  check('**400 で断られても投げずに実況へ行く**', escaped === null,
    escaped ? escaped.message : '');
  eq('実況の値が入る', got?.hours?.[0]?.temp_c, 24.0);
  eq('source は実況', got?.source, 'open-meteo-archive');
}
{
  /* 記録にもちゃんと残ること。**ここが 3 月の釣行で効く** */
  app._reset({ 'api.open-meteo.com/v1/forecast':
                 () => ({ ok: false, status: 400, json: async () => ({ error: true }) }),
               'archive-api': () => okJson(ARCHIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  const snap = await app.captureWeatherSnapshot(
    { lat: 34.66, lng: 137.9, date: '2026-03-09', time: '12:20' });
  eq('**半年前の釣行でも天気が残る**', snap?.source, 'open-meteo-archive');
  eq('値も入っている', snap?.temp_c, 24.0);
}

/* ---- 記録に残す天気にも、どこから来たかを書く ----
   **ここが抜けると、混ざったこと自体が消える。** あとから数え直すとき、
   どの値が予報でどの値が実況なのか、もう誰にも分からない */
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(LIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  const snap = await app.captureWeatherSnapshot(
    { lat: 34.66, lng: 137.9, date: '2026-09-12', time: '18:30' });
  eq('ふだんの記録は予報として残る', snap.source, 'open-meteo');
  check('予報のときは注記を出さない', app.weatherSourceNote(snap) === null);
}
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => okJson(ARCHIVE),
               'marine-api': () => okJson({ hourly: { time: TIMES } }) });
  const snap = await app.captureWeatherSnapshot(
    { lat: 34.66, lng: 137.9, date: '2026-07-12', time: '18:30' });
  eq('**埋めた記録は実況として残る**', snap.source, 'open-meteo-archive');
  eq('値も実況のもの', snap.temp_c, 24.0);
  check('実況のときは注記を出す',
    (app.weatherSourceNote(snap) ?? '').includes('あとから補った'),
    String(app.weatherSourceNote(snap)));
}
check('天気が無ければ注記も無い', app.weatherSourceNote(null) === null);

/* ---- どちらも届かない日は、**天気を残さない** ----
   値が全部 null の「天気」が入ると、画面には何も出ないまま
   「取れなかったのか、本当に無風無降水だったのか」が分からなくなる。
   **残っていないほうがまし。** あとから NULL を探して埋め直せる */
{
  app._reset({ 'api.open-meteo.com/v1/forecast': () => okJson(EMPTY),
               'archive-api': () => ({ ok: false, status: 400, json: async () => ({}) }) });
  const snap = await app.captureWeatherSnapshot(
    { lat: 34.66, lng: 137.9, date: '2026-01-01', time: '18:30' });
  eq('**全部 null の天気は残さない**', snap, null);
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
