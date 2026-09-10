/**
 * メモの言葉で絞る仕組み（D-148）のテスト。
 *   node frontend/tests/memo_words.test.mjs
 *
 * **ここは黙って取りこぼすところ。** 絞り込みが 1 件見落としても、
 * 画面には「3 件」と出るだけで、何件見落としたかは誰にも分からない。
 *
 * 押さえるのは 3 つ。
 *   - **入れる／外すは空白区切りの語で見る。** 部分一致で外すと
 *     「ドチャ濁り」から「濁り」を抜いて「ドチャ」が残る
 *   - **絞り込みはわざと部分一致。** 「濁り」で笹濁りもドチャ濁りも拾う。
 *     この 2 つは規則が違う。同じにすると、どちらかが壊れる
 *   - 本文を壊さない。メモは平均 40 字の本文が先にあり、
 *     言葉はその後ろに足すだけ
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['/** メモに 1 タップで入れられる言葉。**3 段階は弱い順に並べる。** */',
   'export async function checkInvite'],
]);
const { MEMO_TAG_GROUPS, memoTagGroups, memoHasWord, toggleMemoWord,
        memoMatches, memoFilterWords } =
  new Function(code + `; return { MEMO_TAG_GROUPS, memoTagGroups, memoHasWord,
    toggleMemoWord, memoMatches, memoFilterWords };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* ---- 言葉の並び ----
   **3 段階は弱い順。** 画面はこの順でそのまま並べるので、
   ここが崩れると「ドチャ濁り・クリア・笹濁り」のように出る */
eq('濁りは弱い順に 3 つ',
  MEMO_TAG_GROUPS.find((g) => g.key === 'clarity').words,
  ['クリア', '笹濁り', 'ドチャ濁り']);
eq('増水も弱い順に 3 つ',
  MEMO_TAG_GROUPS.find((g) => g.key === 'level').words,
  ['平水', '少し増水', '大増水']);

/* **入れ子になっていること自体を固定する。** これは事故ではなく設計。
   「濁り」で絞ると 2 段階まとめて出る、という仕掛けがここに乗っている */
check('濁りの上 2 段階はどちらも「濁り」を含む',
  ['笹濁り', 'ドチャ濁り'].every((w) => w.includes('濁り')));
check('増水の上 2 段階はどちらも「増水」を含む',
  ['少し増水', '大増水'].every((w) => w.includes('増水')));
check('いちばん薄い段階は入れ子に入らない',
  !'クリア'.includes('濁り') && !'平水'.includes('増水'));

/* ---- そのスポットで意味を持つものだけ ---- */
eq('海のスポットでは増水を出さない',
  memoTagGroups({ water_type: 'saltwater' }).map((g) => g.key), ['clarity', 'rain']);
eq('汽水では増水も出す',
  memoTagGroups({ water_type: 'brackish' }).map((g) => g.key), ['clarity', 'level', 'rain']);
eq('淡水でも増水を出す',
  memoTagGroups({ water_type: 'freshwater' }).map((g) => g.key), ['clarity', 'level', 'rain']);
eq('スポット未選択なら全部出す', memoTagGroups(null).length, MEMO_TAG_GROUPS.length);

/* ---- 入っているかの判定は「空白区切りの語」 ----
   **ここを部分一致にすると外すときに壊れる。** */
check('入っていれば true', memoHasWord('ただ巻き 笹濁り', '笹濁り'));
check('**「ドチャ濁り」があっても「濁り」が入っているとは言わない**',
  memoHasWord('ドチャ濁り', '濁り') === false);
check('「少し増水」があっても「増水」とは言わない',
  memoHasWord('少し増水', '増水') === false);
check('改行区切りでも見つける', memoHasWord('本文\n笹濁り', '笹濁り'));
check('無ければ false', memoHasWord('ただ巻き', '笹濁り') === false);
check('メモが空でも落ちない', memoHasWord(null, '笹濁り') === false);
check('言葉が空なら false', memoHasWord('笹濁り', '') === false);

/* ---- 入れる ---- */
eq('空のメモに入れる', toggleMemoWord('', '笹濁り'), '笹濁り');
eq('本文の後ろに足す', toggleMemoWord('ただ巻き', '笹濁り'), 'ただ巻き 笹濁り');
eq('2 つ目も後ろに足す',
  toggleMemoWord('ただ巻き 笹濁り', '雨後'), 'ただ巻き 笹濁り 雨後');
/* **本文を壊さない。** 実際のメモは改行を含む長い文（最長 173 字） */
eq('改行のある本文でも壊さない',
  toggleMemoWord('散々ボイルが出ていた\nやっとヒット', '笹濁り'),
  '散々ボイルが出ていた\nやっとヒット 笹濁り');
eq('null でも落ちない', toggleMemoWord(null, '雨後'), '雨後');

/* ---- 外す ---- */
eq('外せる', toggleMemoWord('ただ巻き 笹濁り', '笹濁り'), 'ただ巻き');
eq('真ん中のものを外す',
  toggleMemoWord('ただ巻き 笹濁り 雨後', '笹濁り'), 'ただ巻き 雨後');
eq('最後の 1 つを外すと空', toggleMemoWord('笹濁り', '笹濁り'), '');
/* **入れ子を壊さない。** ここが今回いちばん危ないところ */
eq('**「ドチャ濁り」から「濁り」を外そうとしても壊れない**',
  toggleMemoWord('ドチャ濁り', '濁り'), 'ドチャ濁り 濁り');
eq('「少し増水」を「増水」で壊さない',
  toggleMemoWord('少し増水', '増水'), '少し増水 増水');
/* 入れて外して戻ること。**空白が溜まらない** */
eq('入れて外すと元に戻る',
  toggleMemoWord(toggleMemoWord('ただ巻き', '笹濁り'), '笹濁り'), 'ただ巻き');
eq('2 回入れて 2 回外しても溜まらない', (() => {
  let m = 'ただ巻き';
  for (const w of ['笹濁り', '雨後']) m = toggleMemoWord(m, w);
  for (const w of ['笹濁り', '雨後']) m = toggleMemoWord(m, w);
  return m;
})(), 'ただ巻き');
eq('改行のある本文から外しても改行は残る',
  toggleMemoWord('一行目\n二行目 笹濁り', '笹濁り'), '一行目\n二行目');

/* ---- 絞り込みは**わざと部分一致** ----
   入れる／外すとは別の規則。同じにすると、どちらかが壊れる */
check('そのままの言葉で当たる', memoMatches('ただ巻き 笹濁り', '笹濁り'));
check('**「濁り」で笹濁りが出る**', memoMatches('ただ巻き 笹濁り', '濁り'));
check('**「濁り」でドチャ濁りも出る**', memoMatches('ドチャ濁り', '濁り'));
check('「クリア」は「濁り」では出ない', memoMatches('クリア', '濁り') === false);
check('「増水」で少し増水が出る', memoMatches('少し増水', '増水'));
check('「増水」で平水は出ない', memoMatches('平水', '増水') === false);
check('段階を名指しすればその段階だけ',
  memoMatches('笹濁り', 'ドチャ濁り') === false);
// 本文の中に書いてあっても拾う（1 タップの言葉に限らない）
check('自分の言葉で書いてあっても拾う',
  memoMatches('クリアで明るいナイトの時は', 'クリア'));
/* 条件が空なら絞らない。**0 件にしない** */
check('空の条件は全部通す', memoMatches('ただ巻き', '') && memoMatches('', ''));
check('空白だけの条件も全部通す', memoMatches('ただ巻き', '   '));
check('前後の空白は落とす', memoMatches('ただ巻き 笹濁り', '  笹濁り '));
check('メモが無い釣果は当たらない', memoMatches(null, '笹濁り') === false);
check('メモが無くても空の条件なら通る', memoMatches(null, ''));

/* ---- 絞り込みの候補 ---- */
eq('候補は 7 つ', memoFilterWords().length, 7);
check('候補に段階が全部入っている',
  ['クリア', '笹濁り', 'ドチャ濁り', '平水', '少し増水', '大増水', '雨後']
    .every((w) => memoFilterWords().includes(w)));

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
