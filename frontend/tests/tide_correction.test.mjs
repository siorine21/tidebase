/**
 * 潮高改正（時差と潮高比）のテスト（D-133）。
 *   node frontend/tests/tide_correction.test.mjs
 *
 * 036 まで、細分地点の潮高比は 9 地点すべて 1.00 だった。時差だけ入れて
 * 振幅を入れていなかったので、奥浜名湖でも外海と同じだけ潮位が振れる計算に
 * なっていた。実測を入れたことで、**それまで一度も通っていなかった経路**
 * （潮高比 ≠ 1）が動き出す。
 *
 * ここで押さえるのは 1 つ。**満干の点が曲線から浮かないこと。**
 * 毎時値は日内平均のまわりで縮めているので、満干の潮位を縮め忘れると、
 * 曲線は縮んだのに点だけ元の高さに残る。**グラフを見れば分かるが、
 * 気づくのは潮高比を入れた地点を開いたときだけ**なので、機械で押さえる。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export function tideLevelAt', 'export function tideAt'],
  ['/** "HH:MM" を小数の時刻に変換する', 'export function hoursFromHhmm'],
  ['export function hoursFromHhmm', '/* ---------------- 釣行スコア'],
  ['function interpolate(', 'export function describeWeather'],
]);
const { shiftEvents, interpolate, tideLevelAt } =
  new Function(code + '; return { shiftEvents, interpolate, tideLevelAt };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 時刻のずらし ---- */

const ev = [{ time: '06:50', level_cm: 122 }, { time: '20:03', level_cm: 121 }];
{
  const out = shiftEvents(ev, 40, 0, 1);
  check('時差ぶん後ろへずれる', out[0].time === '07:30' && out[1].time === '20:43',
    out.map((e) => e.time).join(' / '));
}
check('日をまたぐぶんは落とす', shiftEvents([{ time: '23:50', level_cm: 100 }], 40).length === 0);
check('時刻が無い行は落とす', shiftEvents([{ level_cm: 100 }], 40).length === 0);

/* ---- 潮高比 ---- */

{
  // 平均 70cm のまわりで 0.5 倍 → 122 は 70 + (122-70)*0.5 = 96
  const out = shiftEvents(ev, 0, 70, 0.5);
  check('潮位が日内平均のまわりで縮む', out[0].level_cm === 96 && out[1].level_cm === 96,
    out.map((e) => e.level_cm).join(' / '));
}
check('潮高比 1 なら潮位は変わらない',
  shiftEvents(ev, 0, 70, 1)[0].level_cm === 122);
check('潮位が無ければ null のまま',
  shiftEvents([{ time: '06:00', level_cm: null }], 0, 70, 0.5)[0].level_cm === null);

/* ---- 本題：点が曲線から浮かないこと ---- */
{
  /* 毎時値と満干を、fetchTideForPoint と**同じ式**で縮めたとき、
     満潮の時刻に曲線を読んだ値と、満潮の点の高さが一致すること。 */
  const levels = [64, 56, 58, 70, 88, 106, 118, 122, 115, 99, 76, 52,
                  32, 19, 16, 27, 49, 75, 99, 115, 121, 116, 103, 85];
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const RATIO = 0.55;
  const shiftedLevels = levels.map((v) => Math.round(mean + (v - mean) * RATIO));
  // 満潮は 07:00 ちょうど（毎時値と同じ時刻）にして、曲線と直接比べられるようにする
  const peak = shiftEvents([{ time: '07:00', level_cm: levels[7] }], 0, mean, RATIO)[0];
  const onCurve = tideLevelAt(shiftedLevels, 7);
  check('縮めた満潮の点が、縮めた曲線の上に乗る',
    Math.abs(peak.level_cm - onCurve) <= 1, `点 ${peak.level_cm} / 曲線 ${onCurve}`);

  // 縮め忘れたら浮くこと（このテストが意味を持つことの確認）
  const notScaled = levels[7];
  // 152px の高さに 130cm を描いているので、15cm 浮けば 18px。目で見て分かる
  check('縮め忘れると実際に浮く（目で見て分かる差）',
    Math.abs(notScaled - onCurve) >= 15, `点 ${notScaled} / 曲線 ${onCurve} → ${Math.abs(notScaled - onCurve)}cm`);
}

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
