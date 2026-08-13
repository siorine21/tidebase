/**
 * 釣行スコアの時間帯まわり（hoursOfDate / bandHours）のテスト。
 *   node frontend/tests/score_bands.test.mjs
 *
 * ここが狂うと **静かに間違った点が出る**。エラーにはならない。
 *   - hoursOfDate: 予報は 2 日ぶん取っているので、日付で絞らないと
 *     翌日の天気で今日の点を出しうる（D-103 で見つけた穴）。
 *   - bandHours: どの時刻を「夜」とみなすかが変わると、
 *     夜の点が別の時刻のものになる。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export function hoursFromHhmm', '/* ---------------- 釣行スコア'],
  ['export function hoursOfDate', '/** "HH:MM" にいちばん近い時刻の予報'],
  ['export const MAZUME_WINDOW_MINUTES', '/* ---- 潮の動きによる加減点'],
]);

const { hoursOfDate, bandHours, timeBandOf, mostCommonBand } = new Function(
  code + '; return { hoursOfDate, bandHours, timeBandOf, mostCommonBand };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* 2 日ぶんの予報。当日と翌日で値を変えてあるので、
   どちらを拾ったかが結果を見れば分かる */
const twoDays = [];
for (const d of ['2026-08-11', '2026-08-12']) {
  for (let h = 0; h < 24; h++) {
    twoDays.push({ time: `${d}T${String(h).padStart(2, '0')}:00`, hour: h,
                   weather_code: d.endsWith('11') ? 0 : 95 });
  }
}

/* ---- 日付で絞る ---- */
eq('当日ぶんだけ返す（件数）', hoursOfDate(twoDays, '2026-08-11').length, 24);
eq('当日ぶんだけ返す（中身）',
  [...new Set(hoursOfDate(twoDays, '2026-08-11').map((h) => h.weather_code))], [0]);
eq('翌日を指定すれば翌日ぶん',
  [...new Set(hoursOfDate(twoDays, '2026-08-12').map((h) => h.weather_code))], [95]);
// 予報に無い日を渡したときに空を返すと、スコアが出なくなる。前の挙動に戻す
eq('予報に無い日付なら絞らずに全部返す', hoursOfDate(twoDays, '2026-01-01').length, 48);
eq('日付を渡さなければ全部返す', hoursOfDate(twoDays, null).length, 48);
eq('空でも落ちない', hoursOfDate([], '2026-08-11'), []);
eq('null でも落ちない', hoursOfDate(null, '2026-08-11'), []);
// time が無い形（古い呼び出し）でも、絞らずに返して動かし続ける
eq('time が無ければ絞らない',
  hoursOfDate([{ hour: 5 }, { hour: 6 }], '2026-08-11').length, 2);

/* ---- 時間帯ごとの候補 ---- */
const sun = { rise: '05:00', set: '18:30' };
const bands = bandHours(twoDays, sun, '2026-08-11');
const hoursOf = (key) => bands[key].map((h) => h.hour);

eq('朝マヅメは日の出にいちばん近い 1 件', hoursOf('morning'), [5]);
// 18:30 は 18 時とも 19 時とも 30 分差。**同じなら早いほうを採る**
// （並び順で先に来たものが残る）。どちらでもよいが、揺れないことが大事
eq('夕マヅメは日没にいちばん近い 1 件（同じ差なら早いほう）', hoursOf('evening'), [18]);
eq('日没が 18:43 なら 19 時のほうが近い',
  bandHours(twoDays, { rise: '05:00', set: '18:43' }, '2026-08-11').evening.map((h) => h.hour), [19]);
// 日中は日の出+1h 〜 日没-1h。境目の 6 時と 17 時は入れない（マヅメ側）
eq('日中はマヅメの外側から', hoursOf('day'), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
// 夜は日をまたぐが、**その日の夜**として未明と夕方以降の両方を入れる
eq('夜は未明と夕方以降の両方', hoursOf('night'), [0, 1, 2, 3, 20, 21, 22, 23]);

check('全部あわせても翌日の行は入らない',
  Object.values(bands).flat().every((h) => h.time.startsWith('2026-08-11')));
// どの時間帯にも入らない時刻があってよい（マヅメの幅ぶん）。重複はしないこと
check('同じ時刻が 2 つの時間帯に入らない', (() => {
  const all = Object.values(bands).flat().map((h) => h.hour);
  return new Set(all).size === all.length;
})());

eq('日の出が取れなければ空', bandHours(twoDays, null, '2026-08-11'), {});
eq('予報が無ければ空', bandHours([], sun, '2026-08-11'), {});

/* ---- 傾向の画面と同じ切り方になっているか ----
   ここがずれると、同じ 1 回の釣行が画面によって時間帯が変わる */
for (const [hour, want] of [[5, 'morning'], [12, 'day'], [19, 'evening'], [22, 'night'], [2, 'night']]) {
  const key = Object.keys(bands).find((k) => hoursOf(k).includes(hour));
  eq(`${hour} 時は ${want}（スコアと傾向で同じ）`, key ?? timeBandOf(sun, `${hour}:00`), want);
}

/* ---- 記録でいちばん多い時間帯（D-115） ----
   よく行く時間帯が未設定だと、★は日によって別の時間帯の点になる。
   設定を促すときに **勝手に切り替えず、数えて見せる** ための値。 */
const rec = (date, time) => ({ fished_at: date, fished_time: time });
const sunFor = () => sun;   // rise 05:00 / set 18:30

eq('いちばん多い時間帯を返す', mostCommonBand([
  rec('2026-08-11', '21:00'), rec('2026-08-11', '22:30'), rec('2026-08-11', '19:40'),
  rec('2026-08-12', '05:10'), rec('2026-08-12', '12:00'),
], sunFor), { key: 'night', count: 3, total: 5 });

// 時刻の無い記録は数に入れない（どの時間帯か決められない）
eq('時刻が無い記録は数えない', mostCommonBand([
  rec('2026-08-11', null), rec('2026-08-11', '21:00'),
], sunFor), { key: 'night', count: 1, total: 1 });
// 日の出が取れない記録（座標未設定など）も数に入れない
eq('日の出が引けない記録は数えない',
  mostCommonBand([rec('2026-08-11', '21:00')], () => null), null);
eq('時刻つきが 1 件も無ければ null',
  mostCommonBand([rec('2026-08-11', null)], sunFor), null);
eq('空でも落ちない', mostCommonBand([], sunFor), null);
eq('null でも落ちない', mostCommonBand(null, sunFor), null);
// "HH:MM:SS" で返ってくることがある（time 型）
eq('秒つきの時刻でも読む',
  mostCommonBand([rec('2026-08-11', '21:00:00')], sunFor), { key: 'night', count: 1, total: 1 });

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
