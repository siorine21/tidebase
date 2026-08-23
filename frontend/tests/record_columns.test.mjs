/**
 * 釣果一覧が「読む列」と「取る列」が食い違っていないかを見張る（D-126）。
 *   node frontend/tests/record_columns.test.mjs
 *
 * record_feed は 44 列ある。全部取ると 1 行 1,420 バイトのうち 611 バイトが
 * 列名で、平均 10 列は空だった。そこで取る列を決め打ちにしたが、
 * **列を減らすと、使っている画面が黙って壊れる**（undefined が出るだけで
 * エラーにならない）。画面のソースを走査して、読んでいる列が
 * 取る列に入っていることを機械で確かめる。
 *
 * ここが赤くなったら、直し方は 2 つのどちらか。
 *   - その列が本当に要る    → app.js の列一覧に足す
 *   - 画面側の書き方が変わった → 下の IGNORE に足す（**理由を書くこと**）
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = read('../assets/app.js');

/** app.js の列一覧をソースから取り出す（実物とテストがずれないように） */
function columnsOf(name) {
  const start = APP.indexOf(`export const ${name} = [`);
  if (start < 0) throw new Error(`${name} が app.js に無い`);
  const end = APP.indexOf('].join(",")', start);
  if (end < 0) throw new Error(`${name} の終わりが見つからない`);
  return new Set(APP.slice(start, end).match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1)));
}

const LIST = columnsOf('RECORD_LIST_COLUMNS');
const TREND = columnsOf('RECORD_TREND_COLUMNS');

/* `r.` で始まるが釣果の列ではないもの。**足すときは理由を書く。** */
const IGNORE = new Set([
  'days', 'n', 'rate', 'key',        // 傾向画面の集計結果（tally の戻り）
  'is',                              // `r.is_mine` の途中一致よけ（正規表現の都合）
  'length',                          // 配列の length
  'map', 'filter', 'slice', 'find',  // 配列のメソッド
  'photo_count',                     // 一覧では枚数だけ見る（列一覧にある）
  'fish_species',                    // fishing_records を直接読む経路の形。ビューには無い
  /* ここから下は**この走査のやり方の限界**。正規表現なので、
     釣果と関係ないものまで拾ってしまう。 */
  'html',                            // href="record.html?id=…" の文字列に当たる
]);

const used = (source) =>
  [...source.matchAll(/\b(?:r|rec|record)\.([a-z_]+)/g)]
    .map((m) => m[1])
    .filter((name) => !IGNORE.has(name));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 一覧を出す 3 画面 + 共通の部品 ---- */
for (const file of ['../records.html', '../index.html', '../spot.html']) {
  const missing = [...new Set(used(read(file)))].filter((c) => !LIST.has(c));
  check(`${file.replace('../', '')} が読む列は、取る列に入っている`,
    missing.length === 0, missing.length ? `不足: ${missing.join(', ')}` : `${LIST.size} 列`);
}

/* ---- 傾向画面は必要な列が違う ---- */
{
  const missing = [...new Set(used(read('../trends.html')))].filter((c) => !TREND.has(c));
  check('trends.html が読む列は、取る列に入っている',
    missing.length === 0, missing.length ? `不足: ${missing.join(', ')}` : `${TREND.size} 列`);
}

/* ---- 一覧でも傾向でも使う共通の部品 ---- */
const HELPERS = ['recordOutcome', 'recordFishName', 'lureCategoryText', 'ownerBadge'];
for (const fn of HELPERS) {
  const start = APP.indexOf(`export function ${fn}(`);
  if (start < 0) { check(`${fn} が app.js にある`, false); continue; }
  const body = APP.slice(start, APP.indexOf('\nexport ', start + 10));
  const needed = [...new Set(used(body))];
  const missingList = needed.filter((c) => !LIST.has(c));
  check(`${fn} が要る列は一覧側にそろっている`,
    missingList.length === 0, missingList.length ? `不足: ${missingList.join(', ')}` : needed.join(', ') || '(なし)');
}
// 到達段階の判定は両方で使う。傾向側にも要る
for (const c of ['outcome', 'is_skunked']) {
  check(`傾向側にも ${c} がある`, TREND.has(c));
}

/* ---- 減らした意味があるか（全 44 列より十分少ないこと） ---- */
check('一覧の列は record_feed の半分以下', LIST.size <= 22, `${LIST.size} 列`);
check('傾向の列は record_feed の半分以下', TREND.size <= 22, `${TREND.size} 列`);

/* ---- 並び替えに使う列は select に無くてよい（PostgREST の仕様）が、
        fished_at と fished_time は画面でも出すので入っていること ---- */
for (const c of ['fished_at', 'fished_time']) {
  check(`一覧に ${c} がある`, LIST.has(c));
}

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
