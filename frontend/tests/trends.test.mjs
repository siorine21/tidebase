/**
 * 傾向の集計（timeBandOf / tally / tideTypeDays）のテスト。
 *   node frontend/tests/trends.test.mjs
 *
 * この 3 つは画面に出る数字そのものなので、間違えても
 * 「もっともらしい数字」が出るだけでエラーにならない。だから押さえておく。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 * 時刻の読み取り（hoursFromHhmm）は実物を一緒に切り出す。
 * ここを差し替えると、境目の試験が本物を見なくなる。
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = src.indexOf(from);
  const end = to ? src.indexOf(to, start) : src.length;
  if (start < 0 || end < 0) throw new Error(`切り出せない: ${from}`);
  return src.slice(start, end);
};
const code = [
  slice('export function hoursFromHhmm', '/* ---------------- 釣行スコア'),
  // 時間帯は釣行スコアと共通なので、マヅメの節にある（D-103）
  slice('export const MAZUME_WINDOW_MINUTES', '/**\n * 時間帯ごとに、点を出す候補'),
  slice('export function tally', 'export function tideTypeDays'),
  slice('export function tideTypeDays', '\n}\n') + '\n}\n',
].join('\n').replaceAll('export function', 'function').replaceAll('export const', 'const');

const { TIME_BANDS, timeBandOf, tally, tideTypeDays } = new Function(
  code + '; return { TIME_BANDS, timeBandOf, tally, tideTypeDays };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* ---- 時間帯 ---- */
const sun = { rise: '05:00', set: '18:30' };

eq('日の出ちょうどは朝マヅメ', timeBandOf(sun, '05:00'), 'morning');
eq('日の出の 59 分後はまだ朝マヅメ', timeBandOf(sun, '05:59'), 'morning');
eq('日の出の 60 分後も朝マヅメ（境目は含む）', timeBandOf(sun, '06:00'), 'morning');
eq('日の出の 61 分後は日中', timeBandOf(sun, '06:01'), 'day');
eq('日の出の 60 分前も朝マヅメ', timeBandOf(sun, '04:00'), 'morning');
eq('日の出の 61 分前は夜', timeBandOf(sun, '03:59'), 'night');

eq('日没ちょうどは夕マヅメ', timeBandOf(sun, '18:30'), 'evening');
eq('日没の 60 分前も夕マヅメ', timeBandOf(sun, '17:30'), 'evening');
eq('日没の 61 分前は日中', timeBandOf(sun, '17:29'), 'day');
eq('日没の 61 分後は夜', timeBandOf(sun, '19:31'), 'night');

eq('真昼は日中', timeBandOf(sun, '12:00'), 'day');
eq('真夜中は夜', timeBandOf(sun, '00:10'), 'night');
eq('深夜 23 時台も夜', timeBandOf(sun, '23:50'), 'night');
eq('秒つきの時刻も読む', timeBandOf(sun, '21:50:00'), 'night');

eq('時刻が無ければ判定しない', timeBandOf(sun, null), null);
eq('日の出が無ければ判定しない（座標未設定のスポット）',
  timeBandOf(null, '21:50'), null);
eq('日の出だけあって日没が無いときも判定しない',
  timeBandOf({ rise: '05:00' }, '05:10'), null);

// 時間帯の並びは画面の並びでもある。入れ替わると読み方が変わる
eq('時間帯は朝→日中→夕→夜の順',
  TIME_BANDS.map((b) => b.key), ['morning', 'day', 'evening', 'night']);

/* ---- 件数 ---- */
const rows = [
  { a: '中潮' }, { a: '中潮' }, { a: '大潮' },
  { a: null }, { a: undefined }, { a: '' }, { a: '小潮' },
];
// 多い順。同数のぶんは名前の順（ja）なので「小潮」が「大潮」より前に来る。
// **潮回りや時間帯はこの並びで出さないこと。** あれは順序のある目盛りなので、
// 画面側で決まった並び（大潮→中潮→…）に置き直す。ここは多い順が要る
// スポットやルアーのための関数。
eq('多い順に並べる', tally(rows, (r) => r.a),
  [{ key: '中潮', n: 2 }, { key: '小潮', n: 1 }, { key: '大潮', n: 1 }]);
check('null・undefined・空文字は数えない',
  tally(rows, (r) => r.a).reduce((s, x) => s + x.n, 0) === 4);
eq('空の入力でも落ちない', tally([], (r) => r.a), []);
eq('rows が無くても落ちない', tally(null, (r) => r.a), []);
// 同数のときに順番が揺れると、画面を開くたび並びが変わって読めない
eq('同数なら名前の順で安定する',
  tally([{ a: 'い' }, { a: 'あ' }], (r) => r.a),
  [{ key: 'あ', n: 1 }, { key: 'い', n: 1 }]);

/* ---- 暦の日数 ---- */
// 潮回りは日付から決まるので、ここでは曜日のように単純な関数で試す
const fakeType = (iso) => (Number(iso.slice(-2)) % 2 ? '奇数' : '偶数');

eq('1 日だけの期間', tideTypeDays('2026-08-01', '2026-08-01', fakeType), { 奇数: 1 });
check('日数の合計が期間の日数と一致する', (() => {
  const got = tideTypeDays('2026-08-01', '2026-08-31', fakeType);
  return Object.values(got).reduce((a, b) => a + b, 0) === 31;
})());
check('月をまたいでも数え漏らさない', (() => {
  const got = tideTypeDays('2026-07-30', '2026-08-02', fakeType);
  return Object.values(got).reduce((a, b) => a + b, 0) === 4;
})());
// 3 月は夏時間の切り替わる国があるが、ここは UTC 正午で進めるのでずれない
check('春先でも 1 日ずつ進む（時差で飛ばさない）', (() => {
  const got = tideTypeDays('2026-03-01', '2026-03-31', fakeType);
  return Object.values(got).reduce((a, b) => a + b, 0) === 31;
})());
check('うるう年の 2 月も数える', (() => {
  const got = tideTypeDays('2028-02-01', '2028-02-29', fakeType);
  return Object.values(got).reduce((a, b) => a + b, 0) === 29;
})());
eq('前後が逆なら空', tideTypeDays('2026-08-31', '2026-08-01', fakeType), {});
eq('日付が無ければ空', tideTypeDays(null, '2026-08-01', fakeType), {});

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
