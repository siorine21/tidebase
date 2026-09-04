/**
 * 仲間内のバトルの集計（D-146）のテスト。
 *   node frontend/tests/battle.test.mjs
 *
 * **ここは信用の問題。** 順位が 1 つでもおかしいと、次から誰も使わなくなる。
 * しかも「合計 3 匹ぶん足りない」は画面を見ても分からない。
 *
 * 押さえるのは 4 つ。
 *   - 数えるかどうかを決めるのは **DB（battle_records）だけ**。ここは並べるだけ。
 *     JS 側で counted をもう一度判定し直すと、**必ずどこかで食い違う**
 *   - 参加表明した人は **1 匹も釣っていなくても並ぶ**（0 と書く）
 *   - 同じ点なら同じ順位（1・1・3）。勝負を分ける決まりを勝手に足さない
 *   - 数えなかったものは **その人のところに理由付きで残る**
 */
import { sliceApp } from './_slice.mjs';

const prelude = `
  function nowInJst() { return { date: "2026-09-10", hhmm: "12:00" }; }
`;
const code = sliceApp([
  ['/** 集計方法。**この 3 つだけ。** */', 'export async function listBattles'],
], prelude);

const { BATTLE_METRICS, battleMetric, battleStandings, battlePhase, BATTLE_SKIP_REASONS } =
  new Function(code + `; return { BATTLE_METRICS, battleMetric, battleStandings,
    battlePhase, BATTLE_SKIP_REASONS };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* 参加表明した 3 人。**この 3 人だけが順位に載る** */
const entrants = [
  { user_id: 'u1', name: 'ユーキ', is_me: true },
  { user_id: 'u2', name: 'たろう' },
  { user_id: 'u3', name: 'はなこ' },
];
const rec = (user, len, counted = true, reason = null) =>
  ({ record_id: `r${Math.random()}`, user_id: user, length_cm: len, counted, reason });

/* ---- 集計方法は 3 つだけ ---- */
eq('集計方法は 3 つ', BATTLE_METRICS.map((m) => m.key),
  ['total_length', 'max_length', 'count']);
eq('知らない key は合計の長さに落とす', battleMetric('なにこれ').key, 'total_length');

/* ---- 合計の長さ ---- */
{
  const rows = [rec('u1', 60), rec('u1', 45), rec('u2', 80), rec('u3', 30)];
  const st = battleStandings(rows, entrants, 'total_length');
  eq('合計の長さで並ぶ', st.map((r) => [r.name, r.value]),
    [['ユーキ', 105], ['たろう', 80], ['はなこ', 30]]);
  eq('順位が振られる', st.map((r) => r.rank), [1, 2, 3]);
  eq('単位も返す', st[0].unit, 'cm');
}

/* ---- いちばん大きい 1 匹 ----
   **合計とは順番が変わる。** ここを取り違えると、
   合計で勝っている人がそのまま 1 位に見えてしまう */
{
  const rows = [rec('u1', 60), rec('u1', 45), rec('u2', 80), rec('u3', 30)];
  const st = battleStandings(rows, entrants, 'max_length');
  eq('いちばん大きい 1 匹で並ぶ', st.map((r) => [r.name, r.value]),
    [['たろう', 80], ['ユーキ', 60], ['はなこ', 30]]);
}

/* ---- 匹数 ---- */
{
  const rows = [rec('u1', 60), rec('u1', 45), rec('u1', 20), rec('u2', 80)];
  const st = battleStandings(rows, entrants, 'count');
  eq('匹数で並ぶ', st.map((r) => [r.name, r.value]),
    [['ユーキ', 3], ['たろう', 1], ['はなこ', 0]]);
  eq('単位は匹', st[0].unit, '匹');
}

/* ---- 数えるかどうかは DB が決める ----
   **JS でもう一度判定し直さない。** 写真の有無も長さの有無も
   counted に畳んである。ここで「長さがあるから数えよう」とやると、
   写真が無くて DB が外したものを JS が拾い直して食い違う */
{
  const rows = [
    rec('u1', 60),
    rec('u1', 90, false, 'photo'),     // 写真が無い。**90cm でも数えない**
    rec('u2', 50),
  ];
  const st = battleStandings(rows, entrants, 'total_length');
  eq('数えないものは点に入らない', st.map((r) => [r.name, r.value]),
    [['ユーキ', 60], ['たろう', 50], ['はなこ', 0]]);
  eq('数えなかったものはその人のところに残る',
    st.find((r) => r.name === 'ユーキ').skipped.map((r) => r.reason), ['photo']);
  eq('数えた人には残らない', st.find((r) => r.name === 'たろう').skipped.length, 0);
  check('理由には直し方が書いてある',
    BATTLE_SKIP_REASONS.photo.fix.includes('写真'), BATTLE_SKIP_REASONS.photo.fix);
}

/* ---- 参加表明した人は 0 でも並ぶ ----
   出ているのに名前が無いと、集計から漏れたのか釣れなかったのかが分からない */
{
  const st = battleStandings([], entrants, 'total_length');
  eq('誰も釣っていなくても 3 人並ぶ', st.map((r) => [r.name, r.value]),
    [['たろう', 0], ['はなこ', 0], ['ユーキ', 0]]);
  eq('全員 0 なら全員 1 位', st.map((r) => r.rank), [1, 1, 1]);
}

/* ---- 参加表明していない人は数えない（本人の指定） ---- */
{
  const rows = [rec('u1', 60), rec('u9', 200)];   // u9 は出ていない
  const st = battleStandings(rows, entrants, 'total_length');
  eq('出ていない人は並ばない', st.map((r) => r.name).includes('u9'), false);
  eq('出ていない人の釣果は点にならない',
    st.reduce((sum, r) => sum + r.value, 0), 60);
}

/* ---- 同じ点なら同じ順位（1・1・3） ----
   勝負を分ける決まり（先に釣ったほうが上、など）は**本人が決めること**。
   勝手に足すと、あとで「なぜこっちが上なのか」を説明できない */
{
  const rows = [rec('u1', 50), rec('u2', 50), rec('u3', 20)];
  const st = battleStandings(rows, entrants, 'total_length');
  eq('同点は同じ順位、次は 3 位', st.map((r) => [r.name, r.rank]),
    [['たろう', 1], ['ユーキ', 1], ['はなこ', 3]]);
}

/* ---- 材料が無くても落ちない ---- */
eq('行が無くても落ちない', battleStandings(null, entrants, 'count').length, 3);
eq('参加者が無ければ空', battleStandings([rec('u1', 50)], null, 'count'), []);
eq('どちらも無ければ空', battleStandings(null, null, 'total_length'), []);

/* ---- いま開催中かどうか ----
   **時計を見るのはここだけ。** 画面のあちこちで比べると、
   境目の表示が場所ごとにずれる。いまは 2026-09-10 12:00（prelude で固定） */
eq('始まる前', battlePhase({ starts_at: '2026-09-11T00:00', ends_at: '2026-09-12T00:00' }),
  'before');
eq('開催中', battlePhase({ starts_at: '2026-09-10T00:00', ends_at: '2026-09-11T00:00' }),
  'running');
eq('終わった', battlePhase({ starts_at: '2026-09-01T00:00', ends_at: '2026-09-02T00:00' }),
  'done');
// 境目。**始まりは含み、終わりは含まない**（DB の >= / < と揃える）
eq('始まりちょうどは開催中',
  battlePhase({ starts_at: '2026-09-10T12:00', ends_at: '2026-09-11T00:00' }), 'running');
eq('終わりちょうどは終了',
  battlePhase({ starts_at: '2026-09-09T00:00', ends_at: '2026-09-10T12:00' }), 'done');
eq('日時が無ければ unknown', battlePhase({}), 'unknown');
eq('null でも落ちない', battlePhase(null), 'unknown');
// 秒まで入ってきても比べられる（PostgREST は timestamp を秒付きで返す）
eq('秒が付いていても比べられる',
  battlePhase({ starts_at: '2026-09-10T00:00:00', ends_at: '2026-09-11T00:00:00' }), 'running');

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
