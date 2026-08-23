/**
 * 釣行スコアの★の色のテスト（D-130）。
 *   node frontend/tests/score_star_colors.test.mjs
 *
 * ★の出し方は 2 つある。
 *   ★☆ 5 つ … 時間別カード・SUMMARY・スコアの説明
 *   ★ 1 つ  … 週間カレンダー（点は色だけで言う）
 *
 * **色が食い違ったら、この 2 つは結び付かない。** 週カレンダーの★が赤で、
 * 時間別カードの★5 が橙だったら、「この日は★5 の時間帯がある」を色から
 * 読み取れない。それがこの表示の根拠なので、成立しなくなる。
 *
 * 色は `--sc` に 1 度だけ書き、描き方（.on / 週カレンダー）はそれを読む。
 * **色の値が 2 か所に書かれていないこと**を機械で押さえる。
 * 目で見て気づける壊れ方ではない（片方の画面を見ているときは合って見える）。
 */
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../assets/theme.css', import.meta.url), 'utf8');
const tide = fs.readFileSync(new URL('../tide.html', import.meta.url), 'utf8');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 点 → 色 は 1 か所だけ ---- */

const defs = new Map();
for (const m of css.matchAll(/\.sc-([1-5])\s*\{([^}]*)\}/g)) {
  const value = /--sc:\s*([^;]+);/.exec(m[2]);
  if (value) defs.set(m[1], value[1].trim());
}
check('★1〜5 の色が --sc に定義されている', defs.size === 5, [...defs.keys()].join(','));
check('5 段が別々の色', new Set(defs.values()).size === 5, [...defs.values()].join(' / '));

// .sc-N が --sc 以外で色を決めていないか（例: `.sc-5 .on { color: red }` の復活）
const strays = [...css.matchAll(/\.sc-[1-5][^{]*\{([^}]*)\}/g)]
  .map((m) => m[1])
  .filter((body) => /(^|[\s;])color\s*:/.test(body));
check('.sc-N が color を直に書いていない', strays.length === 0, strays.join(' | '));

/* ---- 両方の描き方が --sc を読んでいる ---- */

const onRule = /\.sc\s+\.on\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
check('★☆ 5 つ（.sc .on）が --sc を読む', /color:\s*var\(--sc\)/.test(onRule), onRule.trim());

const weekRule = /\.week-grid\s+\.sc\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
check('週カレンダーの★が --sc を読む', /color:\s*var\(--sc\)/.test(weekRule), weekRule.trim());

/* ---- 週カレンダーの★は 1 つ ---- */

// stars() は ★☆ を 5 つ返す。週のセルがそれを使っていたら 5 つに戻っている
const cell = /function dayCell\(date\)[\s\S]*?\n  \}/.exec(tide)?.[0] ?? '';
check('週のセルを読めている', cell.length > 200, `${cell.length} 文字`);
check('週のセルは stars() を使わない（★は 1 つ）',
  !/stars\(/.test(cell), (cell.match(/stars\([^)]*\)/) ?? [''])[0]);
check('週のセルの★は sc-<点> の色分けを持つ', /class="sc sc-\$\{day\.score\}"/.test(cell));

/* ---- 色だけに頼らない ---- */

check('セルに読み上げ用の説明がある', /aria-label="\$\{escapeHtml\(label\)\}"/.test(cell));
check('その説明に点が入っている', /釣行スコア \$\{day\.score\}/.test(cell));

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
