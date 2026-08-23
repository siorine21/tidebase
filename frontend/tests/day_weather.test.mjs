/**
 * 週間カレンダーの 1 マスに出す「その日の天気」（D-130）のテスト。
 *   node frontend/tests/day_weather.test.mjs
 *
 * 前は 12 時の 1 時間で代表させていて、夜に雨が来る日でも晴れのままだった。
 * 同じ画面の見出しが「21時ごろから雨になりそうです」と書いているのに、である。
 *
 *   - **雨の物差しは見出し（rainOutlook）と同じ。** 片方だけ緩めると、
 *     見出しは「少し降るかも」なのにカレンダーは雨、という新しい食い違いになる。
 *   - **返すのは実際にあった時間のコード。** 区分に丸めると、霧雨の日も
 *     本降りの日も同じアイコンになる。
 *   - 12 時が晴れでも、その日が晴れとは限らない（これが元の指摘）。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export function weatherCategory', 'const WIND_DIRS'],
  ['/** 雨が「降っている」と言える降水量', 'export function rainOutlook'],
  ['export function dayWeatherCode', 'export function rainOutlook'],
]);

const { dayWeatherCode, weatherCategory } =
  new Function(code + '; return { dayWeatherCode, weatherCategory };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/** 24 時間ぶんを作る。spec は { 時: [コード, 雨量] } の上書き。 */
const day = (baseCode, spec = {}) =>
  Array.from({ length: 24 }, (_, hour) => {
    const [c, mm] = spec[hour] ?? [baseCode, 0];
    return { hour, weather_code: c, precip_mm: mm };
  });

/* ---------------- 順番: 雷 → 雨 → 曇り → 晴れ ---------------- */

check('一日中晴れなら晴れ', dayWeatherCode(day(0)) === 0);
check('雷は 1 時間でもその日の顔',
  dayWeatherCode(day(0, { 15: [95, 8] })) === 95, String(dayWeatherCode(day(0, { 15: [95, 8] }))));

{
  // これが指摘そのもの: 12 時は晴れ、21〜22 時に雨
  const d = day(0, { 21: [61, 0.2], 22: [61, 0.2] });
  check('12 時が晴れでも、夜に雨が続くならその日は雨',
    dayWeatherCode(d) === 61, String(dayWeatherCode(d)));
}
{
  // 1 時間だけの弱い雨は、見出しも「降る」と言い切らない
  const d = day(0, { 21: [61, 0.2] });
  check('1 時間だけの弱い雨では雨にしない', dayWeatherCode(d) === 0, String(dayWeatherCode(d)));
}
{
  // 1 時間でも、まとまった量なら雨
  const d = day(0, { 21: [63, 0.8] });
  check('1 時間でも 0.5mm/h 以上なら雨', dayWeatherCode(d) === 63, String(dayWeatherCode(d)));
}
{
  // 霧雨の日と本降りの日が同じ顔にならないこと
  const drizzle = day(0, { 10: [51, 0.2], 11: [51, 0.2] });
  const heavy = day(0, { 10: [65, 6], 11: [65, 6] });
  check('雨の強さで顔が変わる',
    dayWeatherCode(drizzle) === 51 && dayWeatherCode(heavy) === 65,
    `${dayWeatherCode(drizzle)} / ${dayWeatherCode(heavy)}`);
}
{
  // いちばん強く降る時間の顔を使う
  const d = day(0, { 10: [51, 0.2], 11: [51, 0.3], 14: [65, 7], 15: [65, 5] });
  check('いちばん強い時間の顔', dayWeatherCode(d) === 65, String(dayWeatherCode(d)));
}
{
  // 雨量はあるのに天気コードが雨でない（Open-Meteo でたまにある）
  const d = day(3, { 10: [3, 0.6] });
  check('雨量だけあってコードが雨でなければ雨の総称',
    dayWeatherCode(d) === 61, String(dayWeatherCode(d)));
}

/* ---------------- 曇り ---------------- */

{
  const d = day(0, Object.fromEntries([...Array(8).keys()].map((i) => [i, [3, 0]])));
  check('1 日の 3 分の 1 が曇りなら曇り', dayWeatherCode(d) === 3, String(dayWeatherCode(d)));
}
{
  const d = day(0, Object.fromEntries([...Array(7).keys()].map((i) => [i, [3, 0]])));
  check('3 分の 1 に届かなければ晴れのまま', dayWeatherCode(d) === 0, String(dayWeatherCode(d)));
}
{
  // 晴れの中でも、多いほうの顔を出す（快晴 0 と晴れ時々曇り 2）
  const d = day(2, { 0: [0, 0], 1: [0, 0] });
  check('晴れの中では多いほうの顔', dayWeatherCode(d) === 2, String(dayWeatherCode(d)));
}

/* ---------------- 材料が無いとき ---------------- */

check('予報が無ければ null', dayWeatherCode(null) === null);
check('空でも null', dayWeatherCode([]) === null);
check('コードが入っていない行は数えない',
  dayWeatherCode([{ hour: 0, weather_code: null, precip_mm: 0 }]) === null);
{
  // 半日ぶんしか無い週の端でも落ちない
  const d = day(0).slice(0, 6);
  check('時間が足りなくても出る', dayWeatherCode(d) === 0);
}

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
