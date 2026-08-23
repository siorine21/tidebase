/**
 * 「いまの潮」と「次の大潮」（D-129）のテスト。
 *   node frontend/tests/tide_now.test.mjs
 *
 * どちらも**すでに手元にあるデータを言い直すだけ**の計算なので、
 * 間違っても画面はいつもどおり出る。数字だけが静かにずれる。
 *
 *   - 次の満干は**翌日ぶんまで見る**。22 時に開いて「今日はもう満潮が無い」で
 *     終わると、夜釣りでいちばん要る情報が消える。
 *   - 日没を過ぎたら**翌朝の日の出**を出す。過ぎた時刻を「あと -30分」で
 *     出さない。
 *   - 大潮の長さは**暦のとおり**返し、「あと何日」は別に返す。1 つの数字で
 *     兼ねると、4 日ある大潮の最終日を起点にしたとき「1 日間」と出て、
 *     その大潮そのものが短いように読める。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['const RAD_PER_DEG', 'export const TIDE_TYPE_COLORS'],   // 朔 → 旧暦日 → 潮回り
  ['export function addJstDays', 'export function weekOf'],
  ['export function hoursFromHhmm', '/* ---------------- 釣行スコア'],
  ['export function formatCountdown', '/**\n * 1 時間ぶんの点（D-115 で切り出した）。'],
]);

const { formatCountdown, nextTideEvent, nextSunEvent, nextSpringTide, tideType, addJstDays } =
  new Function(code + '; return { formatCountdown, nextTideEvent, nextSunEvent,'
    + ' nextSpringTide, tideType, addJstDays };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---------------- 残り時間の書き方 ---------------- */

check('60 分未満は分だけ', formatCountdown(46) === '46分', String(formatCountdown(46)));
check('ちょうどなら「N時間」', formatCountdown(120) === '2時間', String(formatCountdown(120)));
check('時間と分', formatCountdown(166) === '2時間46分', String(formatCountdown(166)));
check('過ぎていれば null', formatCountdown(-1) === null);
check('無ければ null', formatCountdown(null) === null);

/* ---------------- 次の満潮・干潮 ---------------- */

const today = {
  high_tides: [{ time: '05:12', level_cm: 141 }, { time: '18:20', level_cm: 133 }],
  low_tides: [{ time: '11:40', level_cm: 22 }, { time: '23:55', level_cm: 40 }],
};
const tomorrow = {
  high_tides: [{ time: '06:05', level_cm: 138 }],
  low_tides: [{ time: '12:30', level_cm: 18 }],
};

{
  const next = nextTideEvent(today, tomorrow, '09:00');
  check('次に来るものを 1 つ選ぶ',
    next?.label === '干潮' && next.time === '11:40' && next.inMinutes === 160,
    JSON.stringify(next));
  check('潮位も返す', next?.levelCm === 22);
  check('同じ日なら nextDay は false', next?.nextDay === false);
}
{
  const next = nextTideEvent(today, tomorrow, '18:20');
  check('ちょうどの時刻は「次」に数えない',
    next?.label === '干潮' && next.time === '23:55', JSON.stringify(next));
}
{
  // ここが本題。今日ぶんを撃ち尽くしたあと
  const next = nextTideEvent(today, tomorrow, '23:56');
  check('日をまたいで翌日の最初を返す',
    next?.label === '満潮' && next.time === '06:05' && next.nextDay === true,
    JSON.stringify(next));
  // 23:56 → 翌 06:05 は 6 時間 9 分。24 時間ぶんを足さないと負になる
  check('日をまたいだ残り時間は 24 時間ぶん足す', next?.inMinutes === 369,
    String(next?.inMinutes));
}
{
  check('翌日ぶんが無ければ null', nextTideEvent(today, null, '23:56') === null);
  check('潮汐そのものが無ければ null', nextTideEvent(null, null, '09:00') === null);
}

/* ---------------- 次の日の出・日没 ---------------- */

const sunToday = { rise: '05:10', set: '18:32' };
const sunTomorrow = { rise: '05:11', set: '18:31' };

{
  const e = nextSunEvent(sunToday, sunTomorrow, '04:00');
  check('夜明け前は日の出', e?.kind === 'rise' && e.time === '05:10' && e.inMinutes === 70,
    JSON.stringify(e));
}
{
  const e = nextSunEvent(sunToday, sunTomorrow, '17:28');
  check('日中は日没', e?.kind === 'set' && e.time === '18:32' && e.inMinutes === 64,
    JSON.stringify(e));
}
{
  const e = nextSunEvent(sunToday, sunTomorrow, '20:00');
  check('日没後は翌朝の日の出',
    e?.kind === 'rise' && e.time === '05:11' && e.inMinutes === 551, JSON.stringify(e));
  // 「翌」を出すかどうかは残り時間ではなく**日をまたいだかどうか**で決める。
  // 23:56 に 05:16 の日の出は残り 5 時間だが、日付は翌日
  check('日をまたいだことが分かる', e?.nextDay === true);
}
{
  const e = nextSunEvent(sunToday, sunTomorrow, '23:56');
  check('深夜でも翌日の日の出と分かる',
    e?.kind === 'rise' && e.nextDay === true && e.inMinutes === 315, JSON.stringify(e));
}
check('日中の日没は今日', nextSunEvent(sunToday, sunTomorrow, '12:00')?.nextDay === false);
check('日の出日没が無ければ null', nextSunEvent(null, null, '12:00') === null);

/* ---------------- 次の大潮 ---------------- */

// 暦から切り離して、続き方だけを見る
const fake = (map) => (iso) => map[iso] ?? '中潮';
{
  const run = nextSpringTide('2026-08-23', fake({
    '2026-08-28': '大潮', '2026-08-29': '大潮', '2026-08-30': '大潮',
  }));
  check('始まる日と続く日数',
    run?.start === '2026-08-28' && run.days === 3 && run.end === '2026-08-30',
    JSON.stringify(run));
  check('何日先かも返す', run?.inDays === 5 && run.ongoing === false);
  check('まだ始まっていなければ残り = 長さ', run?.remaining === 3);
}
{
  // 3 日ある大潮の 2 日目に見ている
  const run = nextSpringTide('2026-08-29', fake({
    '2026-08-28': '大潮', '2026-08-29': '大潮', '2026-08-30': '大潮',
  }));
  check('いまが大潮なら ongoing', run?.ongoing === true && run.inDays === 0);
  check('途中で見ても、暦どおりの初日と長さを返す',
    run?.start === '2026-08-28' && run.end === '2026-08-30' && run.days === 3,
    JSON.stringify(run));
  check('「あと何日」は起点から数える', run?.remaining === 2, String(run?.remaining));
}
{
  // 最終日だけを起点にしても「1 日間の大潮」にはしない
  const run = nextSpringTide('2026-08-30', fake({
    '2026-08-28': '大潮', '2026-08-29': '大潮', '2026-08-30': '大潮',
  }));
  check('最終日が起点でも長さは 3 日間', run?.days === 3 && run.start === '2026-08-28',
    JSON.stringify(run));
  check('残りは 1 日', run?.remaining === 1);
}
check('見つからなければ null', nextSpringTide('2026-08-23', () => '中潮') === null);
check('起点が無ければ null', nextSpringTide(null, () => '大潮') === null);

{
  // 本物の暦とつないでも動くこと。大潮は月に 2 回あるので、
  // どの日から見ても 20 日以内には必ず始まる
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    const from = addJstDays('2026-01-01', i * 3);
    const run = nextSpringTide(from, tideType);
    if (!run) { worst = 999; break; }
    worst = Math.max(worst, run.inDays);
    if (tideType(run.start) !== '大潮') { worst = 999; break; }
  }
  check('本物の暦でも必ず見つかり、20 日以内に来る', worst <= 20, `最長 ${worst} 日先`);
}

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
