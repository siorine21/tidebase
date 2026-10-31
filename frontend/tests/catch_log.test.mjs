/**
 * CATCH LOG の畳み方（D-181）のテスト。
 *   node frontend/tests/catch_log.test.mjs
 *
 * 本人の案は「直近 2 か月は開く、それ以前は月で畳む、去年からは年で畳む」。
 * そこに合意した 2 点を足してある。
 *   - 「直近 2 か月」は**記録のある**直近 2 か月（暦ではない）。
 *     冬に数か月行かないと、暦の 2 か月では全部畳まれた画面になる
 *   - 絞り込み中は全部開く（当たった記録しか来ないので、畳むと届かない）
 *
 * 押さえるのは、ふだんの形に加えて**境目**:
 *   - 何か月も空いたあと（7 月と 5 月しか無い）
 *   - 1 月の頭（直近 2 か月に去年の 12 月が入る → 去年の年の節が開く）
 *   - 渡される順番が崩れていても、新しい順に並ぶ
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp(['export function catchLogGroups']);
const catchLogGroups = new Function(code + '; return catchLogGroups;')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/** 月ごとの件数から記録を作る。{ "2026-10": 3, ... } */
function recordsOf(counts) {
  const out = [];
  for (const [month, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) out.push({ id: `${month}-${i}`, fished_at: `${month}-${String(10 + i).padStart(2, '0')}` });
  }
  return out;
}
/** 節を見やすい形にする: "2026.10 開" / "2025 閉 [2025.12 閉, …]" */
const shape = (groups) => groups.map((g) => g.kind === 'year'
  ? `${g.label} ${g.open ? '開' : '閉'} [${g.children.map((c) => `${c.label} ${c.open ? '開' : '閉'}`).join(', ')}]`
  : `${g.label} ${g.open ? '開' : '閉'}`);

/* ---- ふだん（本番の並びに近い形。いまは 2026 年 10 月） ---- */
{
  const records = recordsOf({
    '2026-10': 3, '2026-09': 2, '2026-08': 2, '2026-07': 1, '2026-03': 1,
    '2025-10': 1, '2025-06': 2, '2024-11': 1,
  });
  const groups = catchLogGroups(records);
  eq('直近 2 か月は開き、今年のほかの月は畳み、去年より前は年で畳む', shape(groups), [
    '2026.10 開', '2026.09 開', '2026.08 閉', '2026.07 閉', '2026.03 閉',
    '2025 閉 [2025.10 閉, 2025.06 閉]',
    '2024 閉 [2024.11 閉]',
  ]);
  const y2025 = groups.find((g) => g.key === '2025');
  check('年の節は、その年の記録をすべて持つ', y2025.records.length === 3, `${y2025.records.length}`);
  const sum = groups.reduce((n, g) => n + g.records.length, 0);
  check('どの記録もどこか 1 つの節に入る（落ちも重なりも無い）', sum === records.length, `${sum} / ${records.length}`);
}

/* ---- 何か月も空いたあと：暦ではなく「記録のある」直近 2 か月 ---- */
{
  const groups = catchLogGroups(recordsOf({ '2026-07': 2, '2026-05': 1, '2026-03': 1 }));
  eq('記録のある 7 月と 5 月が開く（8〜10 月が空でも全部畳まれない）', shape(groups), [
    '2026.07 開', '2026.05 開', '2026.03 閉',
  ]);
}

/* ---- 1 月の頭：直近 2 か月に去年の 12 月が入る ---- */
{
  const groups = catchLogGroups(recordsOf({ '2027-01': 1, '2026-12': 2, '2026-11': 1, '2025-08': 1 }));
  eq('今年の 1 月と、去年の 12 月が開く（去年の年の節も開く）', shape(groups), [
    '2027.01 開',
    '2026 開 [2026.12 開, 2026.11 閉]',
    '2025 閉 [2025.08 閉]',
  ]);
}

/* ---- 今年の記録がまだ無い 1 月：いちばん新しい年は月で並べる ---- */
{
  const groups = catchLogGroups(recordsOf({ '2026-12': 1, '2026-11': 1, '2026-10': 1 }));
  eq('記録のいちばん新しい年は年で畳まない（開いたら全部畳まれた、にしない）', shape(groups), [
    '2026.12 開', '2026.11 開', '2026.10 閉',
  ]);
}

/* ---- 絞り込み中は全部開く ---- */
{
  const groups = catchLogGroups(recordsOf({ '2026-10': 1, '2026-06': 1, '2025-06': 1 }), { filtered: true });
  eq('絞り込み中は、当たった記録のある月も年も開く', shape(groups), [
    '2026.10 開', '2026.06 開', '2025 開 [2025.06 開]',
  ]);
}

/* ---- 渡される順番が崩れていても、新しい順 ---- */
{
  const records = recordsOf({ '2025-06': 1, '2026-10': 1, '2026-08': 1, '2024-03': 1 }).reverse();
  eq('順番が崩れていても、新しい月・年から並ぶ', shape(catchLogGroups(records)), [
    '2026.10 開', '2026.08 開', '2025 閉 [2025.06 閉]', '2024 閉 [2024.03 閉]',
  ]);
}

/* ---- 1 か月しか無い・空 ---- */
eq('記録が 1 か月ぶんだけでも開く', shape(catchLogGroups(recordsOf({ '2026-10': 2 }))), ['2026.10 開']);
eq('記録が無ければ節も無い', catchLogGroups([]), []);
eq('null でも落ちない', catchLogGroups(null), []);

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
