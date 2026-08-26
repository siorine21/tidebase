/**
 * 感潮（潮汐が届くか）の扱いのテスト（D-134）。
 *   node frontend/tests/tide_influence.test.mjs
 *
 * **感潮域と汽水域は同じものではない。**
 * 国土交通省「河川砂防技術基準 調査編」第14章は、感潮区間を「河口から、
 * 潮汐の変動によって水位が変動する区間」、汽水域を「塩分 0.5〜30‰ の水域」と
 * 別々に定義し、「感潮域にも淡水の区間が存在し、水位に対する潮汐の影響は
 * 塩分濃度が 0.5‰ より低い区間にまで及ぶため、感潮域と汽水域は必ずしも
 * 一致しない」と明記している。包含関係は 感潮域 ⊃ 汽水域。
 *
 * **だから塩分から感潮は導けない。** 5km 上流の淡水でも潮位は動く。
 * ここで押さえるのは「手の指定が水域より強いこと」と、
 * 「指定が無いときだけ水域から決まること」。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export const WATER_TYPES', 'export function spotType'],
  ['export function waterLabel', '/** Google マップで開く URL'],
]);
const { defaultTidal, spotIsTidal, spotWaterLabel, TIDE_INFLUENCES } =
  new Function(code + '; return { defaultTidal, spotIsTidal, spotWaterLabel, TIDE_INFLUENCES };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const spot = (water, tide = null) => ({ water_type: water, tide_influence: tide });

/* ---- 指定が無いとき（自動）は水域から ---- */

check('自動: 海水は潮汐あり', defaultTidal('saltwater') === true);
check('自動: 汽水は潮汐あり', defaultTidal('brackish') === true);
check('自動: 淡水は潮汐なし', defaultTidal('freshwater') === false);
check('自動: 未設定は潮汐あり（海の記録が多いので安全側）', defaultTidal(null) === true);

check('自動の淡水は効かない', spotIsTidal(spot('freshwater')) === false);
check('自動の汽水は効く', spotIsTidal(spot('brackish')) === true);

/* ---- 手の指定が水域より強い（ここが本題） ---- */

check('淡水でも「あり」なら効く（感潮域）',
  spotIsTidal(spot('freshwater', 'tidal')) === true);
check('海水でも「なし」なら効かない',
  spotIsTidal(spot('saltwater', 'none')) === false);
check('汽水でも「なし」なら効かない',
  spotIsTidal(spot('brackish', 'none')) === false);

/* ---- 表示 ---- */

check('淡水＋潮汐ありは「淡水（感潮）」',
  spotWaterLabel(spot('freshwater', 'tidal')) === '淡水（感潮）',
  spotWaterLabel(spot('freshwater', 'tidal')));
check('ただの淡水は「淡水」',
  spotWaterLabel(spot('freshwater')) === '淡水', spotWaterLabel(spot('freshwater')));
check('汽水は感潮と書かない（定義上いつも感潮なので）',
  spotWaterLabel(spot('brackish')) === '汽水', spotWaterLabel(spot('brackish')));
check('海水で外してあれば「海水（潮汐なし）」',
  spotWaterLabel(spot('saltwater', 'none')) === '海水（潮汐なし）',
  spotWaterLabel(spot('saltwater', 'none')));
check('海水はふつう「海水」', spotWaterLabel(spot('saltwater')) === '海水');
check('スポットが無くても落ちない', spotWaterLabel(null) === '—', spotWaterLabel(null));

/* ---- 選べる値 ---- */

check('選べるのは「あり」「なし」の 2 つ（未選択＝自動は選択肢に出さない）',
  TIDE_INFLUENCES.length === 2
  && TIDE_INFLUENCES.map((t) => t.value).join(',') === 'tidal,none',
  TIDE_INFLUENCES.map((t) => t.value).join(','));

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
