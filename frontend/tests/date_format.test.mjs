/**
 * 日付の表記（D-113）のテスト。
 *   node frontend/tests/date_format.test.mjs
 *
 * **画面に出す日付はすべて formatJstDate を通す。**
 * 前は区切りが `.` と `/`、曜日が `水` `(水)` `WED` `無し` の 4 通り、
 * 0 埋めも不揃いで、15 か所が思い思いの形だった。
 * 組み立てるコードが 4 か所にべた書きされていたのが原因なので、
 * **ここが 1 つであることごと**押さえる。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import fs from 'node:fs';
import { sliceApp } from './_slice.mjs';



let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* todayInJst は「いま」に依るので、テストからは固定した年を渡して評価する。
   年を省くかどうかがこれで決まるため、ここを実時刻に任せると
   年が変わった瞬間にテストが落ちる（あるいは通らなくなる）。 */
const build = (todayIso) => {
  const code = sliceApp(
    [['export const WEEKDAYS_EN', '/** 「4日前」']],
    `function todayInJst() { return ${JSON.stringify(todayIso)}; }`);
  return new Function(code + '; return { formatJstDate, WEEKDAYS_EN };')();
};
const { formatJstDate, WEEKDAYS_EN } = build('2026-08-12');

/* ---- 形 ---- */
eq('区切りは . （/ でも - でもない）', formatJstDate('2026-08-12'), '08.12');
eq('曜日は英語 3 文字', formatJstDate('2026-08-12', { weekday: true }), '08.12 WED');
eq('月日は 0 埋めする（等幅で縦をそろえる）',
  formatJstDate('2026-01-05', { weekday: true }), '01.05 MON');

/* ---- 年は今年なら省く ---- */
eq('今年は年を出さない', formatJstDate('2026-03-01', { weekday: true }), '03.01 SUN');
eq('去年は年を出す', formatJstDate('2025-09-03', { weekday: true }), '2025.09.03 WED');
eq('来年も年を出す', formatJstDate('2027-01-01', { weekday: true }), '2027.01.01 FRI');
eq('年を必ず出すこともできる',
  formatJstDate('2026-08-12', { weekday: true, year: true }), '2026.08.12 WED');
eq('年を必ず省くこともできる',
  formatJstDate('2025-09-03', { weekday: true, year: false }), '09.03 WED');

/* ---- 曜日 ----
   1 日ずれると全部ずれるので、日曜から土曜まで一周させて確かめる */
eq('曜日が一周する',
  ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
   '2026-08-13', '2026-08-14', '2026-08-15']
    .map((d) => formatJstDate(d, { weekday: true }).slice(-3)),
  ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
eq('曜日の並びは日曜から', WEEKDAYS_EN,
  ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
// うるう年の 2/29 と、年またぎの前後日
eq('うるう日も正しい', formatJstDate('2028-02-29', { weekday: true }), '2028.02.29 TUE');
eq('大晦日と元日', [formatJstDate('2026-12-31', { weekday: true }),
                    formatJstDate('2027-01-01', { weekday: true })],
  ['12.31 THU', '2027.01.01 FRI']);

/* ---- 受け取れる形 ---- */
eq('時刻が付いていても日付だけ読む',
  formatJstDate('2026-08-12T17:30', { weekday: true }), '08.12 WED');
eq('空白区切りの時刻でも読む',
  formatJstDate('2026-08-12 17:30', { weekday: true }), '08.12 WED');
eq('壊れた値でも落ちない', formatJstDate('なにか'), '');
eq('空でも落ちない', formatJstDate(''), '');
eq('null でも落ちない', formatJstDate(null), '');

/* ---- 年が変わっても同じ規則で動く ---- */
const nextYear = build('2027-01-10');
eq('年が明けると去年の日付に年が付く',
  nextYear.formatJstDate('2026-08-12', { weekday: true }), '2026.08.12 WED');
eq('年が明けたその年は年を出さない',
  nextYear.formatJstDate('2027-01-10', { weekday: true }), '01.10 SUN');

/* ---- 日付を組み立てているのはここだけか ----
   ゆれの原因は「作る場所が散らばっていたこと」。増えていないかを見張る。 */
const files = ['../assets/app.js', '../index.html', '../tide.html', '../news.html',
               '../records.html', '../record.html', '../recipe.html', '../spot.html',
               '../settings.html'];
const weekdayArrays = files.filter((f) => {
  const body = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  return /\[\s*"(SUN|日)"\s*,/.test(body);
});
check('**曜日の配列は app.js に 1 つだけ**', weekdayArrays.length === 1
  && weekdayArrays[0] === '../assets/app.js', weekdayArrays.join(' '));

// 「2026.08.12」「08/12」のような組み立てが画面側に残っていないか
const inlineBuilders = files.slice(1).filter((f) => {
  const body = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  return /slice\(5\)\.replace\("-", "\/"\)/.test(body) || /padStart\(2, "0"\)\}\//.test(body);
});
check('画面側で日付を組み立てていない', inlineBuilders.length === 0, inlineBuilders.join(' '));

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
