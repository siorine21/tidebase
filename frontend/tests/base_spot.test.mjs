/**
 * 基準スポットの選び方（pickBaseSpot / spotTidePoint）のテスト。
 *   node frontend/tests/base_spot.test.mjs
 *
 * ここは **画面に出る場所そのもの**を決める。間違えても
 * 「どこかの場所の天気」が出るだけでエラーにはならないので押さえておく。
 * 実際、前は「最後に登録した淡水以外のスポット」を天気に、
 * 別に選んだ潮汐地点を潮に使っていて、1 行に 2 か所が混ざっていた（D-105）。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
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
  slice('export function pickBaseSpot', ' * お気に入りの潮汐地点'),
  // spotTidePoint が呼ぶ相手。ファイル上はこちらが後ろにある
  slice('/** スポットに紐付いた潮汐地点', '/**\n * 潮汐地点の推算値'),
].join('\n').replaceAll('export function', 'function').replace(/\/\*\*\s*$/, '');

const { pickBaseSpot, spotTidePoint, tidePointOfSpot } = new Function(
  code + '; return { pickBaseSpot, spotTidePoint, tidePointOfSpot };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* listSpots() は is_mine 降順・作成が新しい順で返す。その並びを再現する */
const spot = (id, o = {}) => ({ id, name: id, is_mine: true, water_type: 'saltwater', ...o });

const mine = [
  spot('福田港'),
  spot('アルクスポンド', { water_type: 'freshwater' }),
  spot('はまぼう公園', { water_type: 'brackish' }),
];

/* ---- 選ぶ順番 ---- */
eq('保存した選択がいちばん強い', pickBaseSpot(mine, 'はまぼう公園')?.id, 'はまぼう公園');
eq('保存が無ければ、いちばん新しい淡水以外', pickBaseSpot(mine, null)?.id, '福田港');
// 消したスポットの id が残っていても、そこで止まらずに選び直す
eq('保存した id が見つからなければ既定に落ちる', pickBaseSpot(mine, '消えたスポット')?.id, '福田港');

// 淡水は潮汐を持たないので後回し。ただし淡水しか無ければ淡水を選ぶ
eq('淡水は後回し', pickBaseSpot([
  spot('管理釣り場', { water_type: 'freshwater' }),
  spot('サーフ'),
], null)?.id, 'サーフ');
eq('淡水しか無ければ淡水を選ぶ', pickBaseSpot([
  spot('管理釣り場A', { water_type: 'freshwater' }),
  spot('管理釣り場B', { water_type: 'freshwater' }),
], null)?.id, '管理釣り場A');

// 共有スポットが混ざっても、自分のものを先に見る（D-065）
eq('自分のものを優先する', pickBaseSpot([
  spot('友人のサーフ', { is_mine: false }),
  spot('自分の漁港'),
], null)?.id, '自分の漁港');
eq('自分のものが無ければ共有から選ぶ', pickBaseSpot([
  spot('友人の池', { is_mine: false, water_type: 'freshwater' }),
  spot('友人のサーフ', { is_mine: false }),
], null)?.id, '友人のサーフ');

// 自分のものが淡水だけでも、自分のものを優先する（共有の海には行かない）
eq('自分のものが淡水だけでも自分を優先', pickBaseSpot([
  spot('友人のサーフ', { is_mine: false }),
  spot('自分の管理釣り場', { water_type: 'freshwater' }),
], null)?.id, '自分の管理釣り場');

eq('1 件も無ければ null', pickBaseSpot([], null), null);
eq('spots が無くても落ちない', pickBaseSpot(null, 'なにか'), null);

/* ---- スポット → 潮汐地点 ---- */
const points = [
  { value: 'ST:MI', name: '舞阪' },
  { value: 'AR:HN-BENTEN', name: '弁天' },
];

eq('細分地点を観測所より優先する',
  spotTidePoint({ tide_area_code: 'HN-BENTEN', tide_station_code: 'MI' }, points)?.value,
  'AR:HN-BENTEN');
eq('細分地点が無ければ観測所',
  spotTidePoint({ tide_area_code: null, tide_station_code: 'MI' }, points)?.value, 'ST:MI');
// 淡水スポットは両方 NULL。潮汐の無い場所として扱えるよう null を返す
eq('どちらも無ければ null（淡水）',
  spotTidePoint({ tide_area_code: null, tide_station_code: null }, points), null);
eq('スポットが無ければ null', spotTidePoint(null, points), null);
// 一覧に無いコードを持っていても落ちない（地点表が変わったとき）
eq('地点表に無いコードなら null',
  spotTidePoint({ tide_station_code: 'XX' }, points), null);
eq('地点表が空でも落ちない', spotTidePoint({ tide_station_code: 'MI' }, []), null);

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
