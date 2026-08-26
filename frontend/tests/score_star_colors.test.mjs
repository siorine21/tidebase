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

/* ---- 風の色も同じ形（D-131） ---- */

const winds = new Map();
for (const m of css.matchAll(/\.wnd-([a-z]+)\s*\{([^}]*)\}/g)) {
  const value = /--wind:\s*([^;]+);/.exec(m[2]);
  if (value) winds.set(m[1], value[1].trim());
}
check('風の 4 段が --wind に定義されている',
  ['calm', 'fresh', 'strong', 'danger'].every((k) => winds.has(k)), [...winds.keys()].join(','));
check('4 段が別々の色', new Set(winds.values()).size === 4, [...winds.values()].join(' / '));

const windStrays = [...css.matchAll(/\.wnd-[a-z]+[^{]*\{([^}]*)\}/g)]
  .map((m) => m[1]).filter((body) => /(^|[\s;])color\s*:/.test(body));
check('.wnd-N が color を直に書いていない', windStrays.length === 0, windStrays.join(' | '));

const hourWind = /\.hour-card\s+\.wind\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
check('時間別カードの風が --wind を読む', /color:\s*var\(--wind/.test(hourWind), hourWind.trim());
const weekWind = /\.week-grid\s+\.wnd\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
check('週カレンダーの風が --wind を読む', /color:\s*var\(--wind/.test(weekWind), weekWind.trim());

/* ---- 週セルの風は「いちばん良い時間帯」のもの ---- */

check('風は day.best から取る（その日の平均や最大ではない）',
  /const windMs = day\?\.best\?\.windMs;/.test(cell), 'windMs の取り方');
check('風の段は windLevel が決める（しきい値を書き写さない）',
  /windLevel\(windMs\)/.test(cell));
check('★と風は同じ行（セルの段を増やさない）',
  /class="sc-row"/.test(cell) && !/class="wnd[^"]*"[\s\S]{0,40}<\/span>\s*\n\s*\$\{at\}/.test(cell));

/* ---- モーダルの★も同じ色を使う（D-130 / D-136） ---- */

const appSrc = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const help = /export function showFishingScoreHelp[\s\S]*?\n}/.exec(appSrc)?.[0] ?? '';
check('スコアのモーダルを読めている', help.length > 200, `${help.length} 文字`);
check('モーダルの★が sc と sc-<点> の両方を持つ',
  /class="score-stars sc sc-\$\{score\}"/.test(help),
  (help.match(/class="score-stars[^"]*"/) ?? [''])[0]);

/* ---- 色だけに頼らない ---- */

check('セルに読み上げ用の説明がある', /aria-label="\$\{escapeHtml\(label\)\}"/.test(cell));
check('その説明に点が入っている', /釣行スコア \$\{day\.score\}/.test(cell));
check('その説明に風が入っている', /そのとき風 \$\{Math\.round\(windMs\)\}m\/s/.test(cell));

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
