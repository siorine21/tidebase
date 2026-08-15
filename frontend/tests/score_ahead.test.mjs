/**
 * 「これから 24 時間」の時間帯と点（D-115）のテスト。
 *   node frontend/tests/score_ahead.test.mjs
 *
 * ホームの窓を「今日」から「これから 24 時間」に変えたときの決めごとを押さえる。
 *
 *   - **もう過ぎた時間帯が出ない。** 10 時に見て「日中 07:00 ★5」を
 *     大きく出していたのが元の指摘。行けない時間の点だった。
 *   - **夜が日をまたいでも 1 つ。** bandHours は「その日の夜」として
 *     未明と夕方以降の両方を返す（過去の釣行を分類するため・D-102）。
 *     これを「これから」に流用すると、10 時に見たとき夜の代表が今日の
 *     02 時になり、**まだ来ていない今夜が過ぎたものとして消える**。
 *   - **明日にかかる帯は「明日の」と分かる。**
 *
 * ここが狂っても画面は普通に出る。数字が静かにずれるだけなので押さえる。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import { sliceApp, END } from './_slice.mjs';

const code = sliceApp([
  ['export function weatherCategory', 'export function windDirection'],
  ['export function hoursFromHhmm', 'export function fishingScoreDetail'],
  ['export function fishingScoreDetail', 'export const TIME_BANDS'],
  ['export const TIME_BANDS', 'export function timeBandOf'],
  // 帯・点・これから 24 時間・★の組み立て
  ['export function timeBandOf', 'export function showFishingScoreHelp'],
  ['export function uniqueHours', 'export function renderHourlyStrip'],
]);

const { bandRunsAhead, fishingScoreAhead, fishingScoreOfDay, hourScorer, stars } =
  new Function(code
    + '; return { bandRunsAhead, fishingScoreAhead, fishingScoreOfDay, hourScorer, stars };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* 2 日ぶんの予報。晴れ・弱風で揃えて、時間帯の切れ方だけを見る */
const days = ['2026-08-13', '2026-08-14'];
const hours = [];
for (const d of days) {
  for (let h = 0; h < 24; h++) {
    hours.push({ time: `${d}T${String(h).padStart(2, '0')}:00`, hour: h,
                 weather_code: 0, wind_speed_ms: 2 });
  }
}
const SUN = { rise: '05:00', set: '18:30' };
const sunOf = () => SUN;

/* ---- まとまりの切れ方 ---- */
const runsAt = (hhmm) => bandRunsAhead(hours, `2026-08-13T${hhmm}`, sunOf, 24);
const shape = (runs) => runs.map((r) =>
  `${r.label}${r.date === '2026-08-13' ? '' : '(翌)'}:${r.rows[0].hour}-${r.rows.at(-1).hour}`);

eq('10 時に見ると、日中から始まる', shape(runsAt('10:00')),
  ['日中:10-17', '夕マヅメ:18-19', '夜:20-3', '朝マヅメ(翌):4-6', '日中(翌):7-9']);
check('**過ぎた朝マヅメは出てこない**',
  !shape(runsAt('10:00')).some((s) => s.startsWith('朝マヅメ:')), shape(runsAt('10:00')).join(' '));
check('**今夜が消えない**（夜の代表が今日の未明にならない）',
  shape(runsAt('10:00')).some((s) => s.startsWith('夜:20')), shape(runsAt('10:00')).join(' '));
eq('夜は日をまたいでも 1 つのまとまり',
  runsAt('10:00').filter((r) => r.key === 'night').length, 1);
eq('日をまたぐ夜の中身は 20 時から翌 3 時まで続く',
  runsAt('10:00').find((r) => r.key === 'night').rows.map((r) => r.hour),
  [20, 21, 22, 23, 0, 1, 2, 3]);

eq('0 時に見ると、夜の続きから始まる', shape(runsAt('00:30')),
  ['夜:0-3', '朝マヅメ:4-6', '日中:7-17', '夕マヅメ:18-19', '夜:20-23']);
eq('22 時に見ても、そこからの夜が出る', shape(runsAt('22:00'))[0], '夜:22-3');
eq('予報が無ければ空', bandRunsAhead([], '2026-08-13T10:00', sunOf), []);
eq('日の出が取れなければ空', bandRunsAhead(hours, '2026-08-13T10:00', () => null), []);

/* ---- 点 ---- */
const ahead = (hhmm, opt = {}) => fishingScoreAhead({
  hours, nowIso: `2026-08-13T${hhmm}`,
  contextOf: () => ({ sun: SUN, tide: null, tideType: '大潮' }),
  tideMatters: false, ...opt,
});

/* **切らない**（D-116）。前は 4 つに切っていたが、それは帯の並びが 4 列だったから。
   並びをやめて 1 時間ごとの★にしたので、円の点は 24 時間の最高点でなければ
   ★と食い違う。切ると 5 つ目のまとまりの点が円に出なくなる。 */
eq('まとまりは切らずに全部返す',
  ahead('10:00').bands.map((b) => b.label), ['日中', '夕マヅメ', '夜', '朝マヅメ', '日中']);
check('**過ぎた時間帯の点を円に出さない**（今日の朝マヅメは出ない）',
  ahead('10:00').bands.every((b) => !(b.label === '朝マヅメ' && !b.tomorrow)),
  ahead('10:00').bands.map((b) => (b.tomorrow ? '明日の' : '') + b.label).join(' '));
/* 名前に「明日の」を足さない（4 つ並びで折り返して背が伸びる）。
   明日かどうかは tomorrow で持ち、画面が時刻の行に出す */
eq('明日にかかる帯は tomorrow が立つ',
  ahead('10:00').bands.find((b) => b.key === 'morning').tomorrow, true);
check('**名前には「明日の」を付けない**',
  ahead('10:00').bands.every((b) => !b.label.startsWith('明日')),
  ahead('10:00').bands.map((b) => b.label).join(' '));
eq('今日のうちの帯には付かない', ahead('10:00').bands[0].tomorrow, false);
// マヅメは日の出・日没そのものを見せる（1 時間刻みに丸めない）
eq('夕マヅメの時刻は日没そのもの',
  ahead('10:00').bands.find((b) => b.key === 'evening').at, '18:30');
eq('明日の朝マヅメの時刻は日の出そのもの',
  ahead('10:00').bands.find((b) => b.key === 'morning').at, '05:00');

/* 代表はいつでも**窓の中でいちばん良い帯**（D-123。帯を指定する設定はやめた） */
eq('代表は窓の中でいちばん点の高い帯',
  ahead('10:00').best.score,
  Math.max(...ahead('10:00').bands.map((b) => b.score)));
eq('窓を狭めると帯も窓のぶんだけ',
  ahead('10:00', { count: 6 }).bands.map((b) => b.label), ['日中']);

/* ---- 円の点と、1 時間ごとの★が食い違わないか（D-116） ----
   ホームは円（最高点）と★（1 時間ごと）を同じ画面に並べる。
   **円に出ている点が、どのカードにも無い**という状態を作らないこと。 */
const scoreOf = hourScorer({ contextOf: () => ({ tideType: '大潮' }), tideMatters: false });
const windowRows = (hhmm, n = 24) => {
  const from = `2026-08-13T${hhmm}`;
  const runs = bandRunsAhead(hours, from, sunOf, n);
  return runs.flatMap((r) => r.rows);
};
for (const at of ['00:30', '10:00', '18:00', '22:00']) {
  const day = ahead(at);
  const best = Math.max(...windowRows(at).map((r) => scoreOf(r)));
  eq(`${at} は円の点＝24 時間の★の最高`, day.score, best);
}
eq('1 時間ごとの点は 1〜5', (() => {
  const all = windowRows('10:00').map((r) => scoreOf(r));
  return [Math.min(...all) >= 1, Math.max(...all) <= 5];
})(), [true, true]);
eq('予報の行が無ければ null', scoreOf(null), null);

eq('予報が無ければ null', fishingScoreAhead({
  hours: [], nowIso: '2026-08-13T10:00', contextOf: () => ({ sun: SUN }) }), null);

/* ---- 「今日」で切るのと、どう違うか ----
   直す前の姿を並べて置いておく。戻ったら気づけるようにする */
const today = fishingScoreOfDay({
  tideType: '大潮', hours, sun: SUN, tideMatters: false, date: '2026-08-13' });
check('**「今日」で切ると、10 時でも朝マヅメが並ぶ**（直す前の姿）',
  today.bands.some((b) => b.label === '朝マヅメ'),
  today.bands.map((b) => `${b.label} ${b.at}`).join(' / '));
check('「今日」で切ると夜の代表は未明になりうる',
  Number(String(today.bands.find((b) => b.key === 'night').at).slice(0, 2)) < 5,
  today.bands.find((b) => b.key === 'night').at);

/* ---- ★☆ の組み立て（D-118） ----
   時間別天気のカードは段階ごとに色を変えるので、
   **点いている分と消えている分を分けた HTML** が要る。
   幅は 5 つぶんで固定（54px のカードに収める前提）なので、
   **どの点でも必ず 5 つ**であること。 */
eq('★2 は ★★☆☆☆', stars(2), '★★☆☆☆');
eq('★5 は ★★★★★', stars(5), '★★★★★');
eq('どの点でも 5 つ（幅が変わらない）',
  [1, 2, 3, 4, 5].map((n) => stars(n).length), [5, 5, 5, 5, 5]);
eq('分けた形は on と off の 2 つ', stars(2, { html: true }),
  '<span class="on">★★</span><span class="off">☆☆☆</span>');
eq('5 なら off は空', stars(5, { html: true }),
  '<span class="on">★★★★★</span><span class="off"></span>');
// 範囲外や壊れた値でも 5 つに収める（repeat は負の数で落ちる）
eq('0 でも落ちない', stars(0), '☆☆☆☆☆');
eq('範囲を超えても 5 つ', [stars(9).length, stars(-3).length], [5, 5]);
eq('数字でなくても落ちない', stars(null), '☆☆☆☆☆');

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
