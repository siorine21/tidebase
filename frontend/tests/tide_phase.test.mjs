/**
 * 「上げ 4 分」の言い方（D-138）のテスト。
 *   node frontend/tests/tide_phase.test.mjs
 *
 * **N 分は潮位の絶対位置**（干潮 0 分 / 満潮 10 分）。時間の割合ではない。
 * ここを取り違えると、下げ潮のときに数字が逆向きになる。
 * 「上げ三分」と「下げ七分」はどちらも**転換から 3 割動いた点**で、
 * 釣りの言い回しで対になっているのはそのため。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export function tideLevelAt', 'export function tideAt'],
  ['function interpolate(', 'function shiftEvents'],
  ['/** "HH:MM" を小数の時刻に変換する', 'export function hoursFromHhmm'],
  ['export function hoursFromHhmm', '/* ---------------- 釣行スコア'],
  ['export function tidePhaseAt', '/**\n * 1 時間ぶんの点（D-115 で切り出した）。'],
]);
const { tidePhaseAt } = new Function(code + '; return { tidePhaseAt };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* きれいな半日周期をつくる。0 時に干潮(0cm)、6 時に満潮(100cm)、
   12 時に干潮、18 時に満潮。潮位は余弦で動かす */
const levels = Array.from({ length: 24 }, (_, h) =>
  Math.round(50 - 50 * Math.cos((h / 6) * Math.PI)));
const tide = { hourly_levels_cm: levels };
const around = { previous: tide, next: tide };
const at = (hhmm) => tidePhaseAt(tide, hhmm, around);

console.log('潮位:', levels.join(' '));

/* ---- 上げ潮：干潮 0 時 → 満潮 6 時 ---- */

check('干潮の直後は 上げ0分 近辺', at('00:30')?.tenth <= 1 && at('00:30')?.rising === true,
  at('00:30')?.label);
check('半分まで上がったら 上げ5分', at('03:00')?.label === '上げ5分', at('03:00')?.label);
check('満潮の手前は 上げ9〜10分', at('05:30')?.tenth >= 9, at('05:30')?.label);

/* ---- 下げ潮：満潮 6 時 → 干潮 12 時。**数字は 10 から減る** ---- */

check('満潮の直後は 下げ9〜10分', at('06:30')?.tenth >= 9 && at('06:30')?.rising === false,
  at('06:30')?.label);
check('半分まで下がったら 下げ5分', at('09:00')?.label === '下げ5分', at('09:00')?.label);
check('干潮の手前は 下げ0〜1分', at('11:30')?.tenth <= 1, at('11:30')?.label);

/* ---- ここが本題：上げ三分と下げ七分は「どちらも転換から 3 割」 ---- */
{
  // 干潮 0 時から 3 割上がった時刻（余弦なので acos で逆算）
  const t3 = (6 / Math.PI) * Math.acos(1 - 2 * 0.3);
  const hh = `${String(Math.floor(t3)).padStart(2, '0')}:${String(Math.round((t3 % 1) * 60)).padStart(2, '0')}`;
  check('干潮から 3 割上がったら 上げ3分', at(hh)?.label === '上げ3分', `${hh} → ${at(hh)?.label}`);

  // 満潮 6 時から 3 割下がった時刻
  const t7 = 6 + (6 / Math.PI) * Math.acos(2 * 0.7 - 1);
  const hh7 = `${String(Math.floor(t7)).padStart(2, '0')}:${String(Math.round((t7 % 1) * 60)).padStart(2, '0')}`;
  check('満潮から 3 割下がったら 下げ7分', at(hh7)?.label === '下げ7分', `${hh7} → ${at(hh7)?.label}`);
  check('上げ3分と下げ7分は、どちらも転換から 3 割動いた点',
    at(hh)?.tenth === 3 && at(hh7)?.tenth === 7);
}

/* ---- 日をまたぐ区間 ---- */

check('前後の日を渡さないと、日の端では出せないことがある',
  tidePhaseAt(tide, '00:10') === null || tidePhaseAt(tide, '00:10')?.tenth != null);
check('前後の日を渡せば日の端でも出る', at('00:10')?.label != null, at('00:10')?.label);
check('23 時台も出る', at('23:30')?.label != null, at('23:30')?.label);

/* ---- 材料が無いとき ---- */

check('潮汐が無ければ null', tidePhaseAt(null, '12:00') === null);
check('時刻が無ければ null', tidePhaseAt(tide, null) === null);
check('平らな潮位では null',
  tidePhaseAt({ hourly_levels_cm: Array(24).fill(50) }, '12:00',
    { previous: { hourly_levels_cm: Array(24).fill(50) },
      next: { hourly_levels_cm: Array(24).fill(50) } }) === null);

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
