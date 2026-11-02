/**
 * 魚図鑑（D-182）の組み立てのテスト。
 *   node frontend/tests/fish_book.test.mjs
 *
 * 図鑑は**自分たちの釣果から作る**。押さえるのは:
 *   - 全種が並び、釣っていない魚種は「まだ」（本人の選択）
 *   - 数えるのは「釣った」記録だけ。バラシ・アタリ・目視・ボウズ・魚種なしは数えない
 *   - 自分の図鑑とグループの図鑑で、埋まり方が変わる
 *   - 初めて・最大・匹数・季節・場所・誰が、が釣果と合う
 *   - 札の写真は「いちばん大きかった 1 匹」を優先する
 *   - 自分の魚種一覧に無い魚種（仲間が自分用に足したもの）でも、釣果が見えていれば載る
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export const OUTCOMES', '/**\n * 釣果一覧。'],
  'export const RECORD_BOOK_PROGRESS_COLUMNS',
  'export function fishBook',
]);
const { fishBook, PROGRESS } = new Function(code + '; return { fishBook, PROGRESS: RECORD_BOOK_PROGRESS_COLUMNS };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const SPECIES = [
  { id: 'sz', name: 'マルスズキ', category: '海水' },
  { id: 'hr', name: 'ヒラメ', category: '海水' },
  { id: 'nb', name: 'ニベ', category: '海水' },
  { id: 'kd', name: 'クロダイ', category: '汽水' },
];
let seq = 0;
const rec = (o) => ({
  id: `r${seq++}`, user_id: 'me', is_mine: true, owner_name: 'ユーキ',
  fished_at: '2026-09-01', fished_time: '05:00:00', outcome: 'landed', is_skunked: false,
  fish_species_id: 'sz', species_name: 'マルスズキ', length_cm: null, catch_count: 1,
  spot_name: '天竜川河口', photo_thumb_path: null, ...o,
});
const RECORDS = [
  rec({ fished_at: '2025-06-02', length_cm: '55.0', spot_name: '浜名湖 新居' }),            // 自分の初めてのスズキ
  rec({ fished_at: '2026-09-12', length_cm: '74.0', photo_thumb_path: null }),             // 自分の最大（写真なし）
  rec({ fished_at: '2026-09-20', length_cm: '62.0', photo_thumb_path: 'p/62.jpg' }),        // 写真のある中で最大
  rec({ fished_at: '2026-10-03', length_cm: null, catch_count: 3, photo_thumb_path: 'p/new.jpg' }),
  rec({ fished_at: '2026-10-05', outcome: 'lost', length_cm: '90.0' }),                    // バラシは数えない
  rec({ fished_at: '2026-10-06', outcome: 'bite' }),
  rec({ fished_at: '2026-10-07', outcome: 'sighting' }),
  rec({ fished_at: '2026-10-08', outcome: 'none', is_skunked: true, fish_species_id: null }),
  rec({ fished_at: '2026-10-09', fish_species_id: null, species_name: null }),              // 魚種なしの釣果
  rec({ fished_at: '2026-10-10', fish_species_id: 'nb', species_name: 'ニベ', outcome: 'lost', length_cm: '60.0' }), // バラシしかない魚種
  rec({ fished_at: '2026-10-11', fish_species_id: 'kd', species_name: 'クロダイ',
    outcome: null, is_skunked: true }),                                                     // 古い形のボウズ（outcome が無い・魚種は狙い）
  // 仲間の釣果
  rec({ user_id: 'taro', is_mine: false, owner_name: 'たろう', fish_species_id: 'hr', species_name: 'ヒラメ',
    fished_at: '2026-08-15', length_cm: '51.0', photo_thumb_path: 'p/hirame.jpg', spot_name: '中田島' }),
  rec({ user_id: 'taro', is_mine: false, owner_name: 'たろう', fished_at: '2024-11-03', length_cm: '80.0',
    spot_name: '天竜川河口' }),                                                              // 仲間のほうが早くて大きい
  // 仲間が自分用に足した魚種（自分の魚種一覧には無い）
  rec({ user_id: 'taro', is_mine: false, owner_name: 'たろう', fish_species_id: 'x-own', species_name: 'アカメ',
    fished_at: '2026-07-01', length_cm: '70.0' }),
];

/* ---- 自分の図鑑 ---- */
{
  const book = fishBook(SPECIES, RECORDS, { mine: true });
  eq('全種が並ぶ（釣っていない魚種も）', book.map((e) => `${e.name}:${e.caught ? '済' : 'まだ'}`),
    ['マルスズキ:済', 'ヒラメ:まだ', 'ニベ:まだ', 'クロダイ:まだ']);
  const sz = book[0];
  check('**数えるのは「釣った」記録だけ**（バラシ・アタリ・目視・ボウズ・魚種なしは除く）', sz.records === 4, `${sz.records} 件`);
  check('匹数は catch_count の合計（1 投稿に 3 匹もある）', sz.fish === 6, `${sz.fish} 匹`);
  check('**バラシの 90cm は最大にしない**', sz.best?.length_cm === '74.0', sz.best?.length_cm);
  check('初めて釣ったのは 2025-06-02（浜名湖 新居）', sz.first.fished_at === '2025-06-02' && sz.first.spot_name === '浜名湖 新居');
  check('**札の写真は、写真のある中でいちばん大きい 1 匹**（最大の 74cm には写真が無い）', sz.photo === 'p/62.jpg', sz.photo);
  eq('季節（月ごとの匹数）', sz.months, [0, 0, 0, 0, 0, 1, 0, 0, 2, 3, 0, 0]);
  eq('よく釣れる場所（匹数の多い順）', sz.spots, [{ name: '天竜川河口', fish: 5 }, { name: '浜名湖 新居', fish: 1 }]);
  eq('最近の釣果は新しい順に 3 件', sz.recent.map((r) => r.fished_at), ['2026-10-03', '2026-09-20', '2026-09-12']);
  eq('自分の図鑑に、仲間の釣った人は出ない', sz.people.map((p) => p.name), ['自分']);
  check('自分の一覧に無い魚種は、自分の図鑑には出ない（自分は釣っていない）', book.length === 4, `${book.length}`);
  check('バラシしかない魚種は「まだ」（ニベ）', book.find((e) => e.id === 'nb').caught === false);
  check('古い形のボウズ（outcome が無く、狙いの魚種だけ入っている）は数えない（クロダイ）', book.find((e) => e.id === 'kd').caught === false);
}

/* ---- グループの図鑑 ---- */
{
  const book = fishBook(SPECIES, RECORDS, { mine: false });
  eq('**グループでは仲間の釣果でも埋まる**（ヒラメ）・一覧に無い魚種は末尾に出る',
    book.map((e) => `${e.name}:${e.caught ? '済' : 'まだ'}`),
    ['マルスズキ:済', 'ヒラメ:済', 'ニベ:まだ', 'クロダイ:まだ', 'アカメ:済']);
  const sz = book[0];
  check('グループの最大は仲間の 80cm', sz.best?.length_cm === '80.0' && sz.best.owner_name === 'たろう');
  check('グループの初めては仲間の 2024-11-03', sz.first.fished_at === '2024-11-03');
  eq('釣った人（匹数の多い順・自分は「自分」）', sz.people, [
    { name: '自分', mine: true, fish: 6, best: '74.0' },
    { name: 'たろう', mine: false, fish: 1, best: '80.0' },
  ]);
  const extra = book.at(-1);
  check('一覧に無い魚種は、釣果に付いている名前で出る', extra.name === 'アカメ' && extra.category === null && extra.caught);
}

/* ---- ホームの入口（4 列だけ読む）---- */
{
  // ホームは図鑑の「埋まった数」だけを出すので、4 列しか取らない。
  // **その 4 列だけで、図鑑の画面（全部の列）と同じ魚種が埋まる**こと。
  // 埋まったかどうかの判定が別の列を見るようになると、ホームと図鑑の数が食い違う
  const cols = PROGRESS.split(',');
  const thin = RECORDS.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  for (const mine of [true, false]) {
    const full = fishBook(SPECIES, RECORDS, { mine }).filter((e) => e.caught).map((e) => e.id);
    const part = fishBook(SPECIES, thin, { mine }).filter((e) => e.caught).map((e) => e.id);
    eq(`**4 列だけでも、図鑑の画面と同じ魚種が埋まる**（${mine ? '自分' : 'グループ'}）`, part, full);
  }
}

/* ---- 端 ---- */
eq('釣果が無ければ全部「まだ」', fishBook(SPECIES, [], { mine: true }).map((e) => e.caught), [false, false, false, false]);
eq('null でも落ちない', fishBook(null, null), []);
{
  const only = fishBook(SPECIES, [rec({ fish_species_id: 'kd', length_cm: null, photo_thumb_path: null, catch_count: 2 })]);
  const kd = only.find((e) => e.id === 'kd');
  check('長さも写真も無い釣果でも載る（最大なし・写真なし）', kd.caught && kd.best === null && kd.photo === null && kd.fish === 2);
}

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
