/**
 * 釣行スコアの決め方（D-139）のテスト。
 *   node frontend/tests/score_factors.test.mjs
 *
 * 「そろった条件の数」（D-135）をやめ、**1.0 をふつうとした係数の幾何平均**にした。
 * 前の式は実データ 112 日で **時間の★の 67% が ★3** になっていて、
 * しかも ★3 は真ん中ではなく**下限**だった（★1・★2 は荒天ゲートからしか出ない）。
 *
 * ここで押さえるのは 6 つ。
 *   - 釣りにならないのは雷と暴風だけ。**雨でゲートしない**
 *     （霧雨で ★2 にしていたせいで、本人が実際に釣った 20 件のうち 7 件が
 *       「釣りにならない」と判定されていた）
 *   - 掛け算になっている（ひとつ悪いと全体が引きずられる）
 *   - **時間帯（マヅメ）を点に入れない**
 *   - 該当しない要素は分母から外す／材料が無い要素は 1.0 で分母に残す
 *   - 日と時間で★の切れ目が違う
 *   - 潮高比は約分されて点に入らない（D-133）
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['const WMO = {', 'export function describeWeather'],
  ['export function weatherCategory', 'const WIND_DIRS'],
  // 係数の describe が使うので先に置く
  ['export const TIDE_FLOW_RULES', 'export function tideFlowAt'],
  ['/* ---- 釣りにならない条件（D-139）', 'export function fishingScore('],
  ['export function springFlowRatio', '/**\n * 1 時間ごとの点を出す関数を作る（D-116）。'],
]);
const {
  fishingScoreDetail, springFlowRatio, curveAt, starFromValue,
  SCORE_FACTORS, SCORE_BLOCKS, HOUR_CUTS, DAY_CUTS, WIND_CURVE, BLOCK_WIND_MS,
} = new Function(code + `; return { fishingScoreDetail, springFlowRatio, curveAt,
  starFromValue, SCORE_FACTORS, SCORE_BLOCKS, HOUR_CUTS, DAY_CUTS, WIND_CURVE,
  BLOCK_WIND_MS };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/** 条件の良い 1 時間 */
const good = {
  weatherCode: 0, wind: 3,
  flowRatio: 0.9, flow: { key: 'start', direction: '上げ潮', cmPerHour: 24 },
  phase: { tenth: 4, rising: true, label: '上げ4分' },
  pressureTrend: -2, tideMatters: true,
};
const at = (over, cuts) => fishingScoreDetail({ ...good, ...over }, cuts);
const facOf = (d, key) => d.factors.find((f) => f.key === key);

/* ---- 釣りにならない条件 ---- */

check('雷はそれだけで ★1', at({ weatherCode: 95 }).score === 1);
check('雷は block に理由が入る', at({ weatherCode: 95 }).block?.label === '雷');
check(`風速 ${BLOCK_WIND_MS}m/s 以上はそれだけで ★1`, at({ wind: BLOCK_WIND_MS }).score === 1);
check('釣りにならない条件は 2 つだけ', SCORE_BLOCKS.length === 2,
  SCORE_BLOCKS.map((b) => b.key).join(','));

/* **これが D-139 の核心。** 霧雨（51）で釣りにならない扱いにしていた。
   本人の釣果 20 件のうち 7 件が code 51・風 1.0〜4.8m/s で ★2 だった。
   罠: 雨を SCORE_BLOCKS に戻すと、ここで落ちる。 */
check('霧雨では止めない', at({ weatherCode: 51 }).block === null);
check('雨でも止めない', at({ weatherCode: 63 }).block === null);
check('霧雨は係数も下げない', facOf(at({ weatherCode: 51 }), 'rain').factor === 1);
check('強い雨は少しだけ下げる', (() => {
  const f = facOf(at({ weatherCode: 65 }), 'rain').factor;
  return f > 0.7 && f < 1;                       // 0 にはしない（掛け算が潰れる）
})(), String(facOf(at({ weatherCode: 65 }), 'rain').factor));
check('霧雨でも良い条件なら高い点が出る', at({ weatherCode: 51 }).score >= 4,
  String(at({ weatherCode: 51 }).score));

/* ---- 掛け算になっているか ---- */

check('全部ふつうなら 1.0', (() => {
  const d = fishingScoreDetail({ weatherCode: 0, wind: null, flowRatio: null,
    flow: null, pressureTrend: null, tideMatters: true });
  return Math.abs(d.value - 1) < 1e-9;
})());

/* **足し算ではなく掛け算。**
   ゆるく「下がること」だけ見ると算術平均でも通ってしまうので、
   **積の n 乗根そのものと一致するか**を見る。罠: 算術平均にすると落ちる。 */
check('値は係数の積の n 乗根（幾何平均）', (() => {
  const d = at({ wind: 12 });
  const used = d.factors.filter((f) => f.applicable).map((f) => f.factor);
  const geo = used.reduce((a, b) => a * b, 1) ** (1 / used.length);
  return Math.abs(d.value - geo) < 1e-12;
})());
/* 掛け算の効きめ: バラついているとき、幾何平均は算術平均より必ず小さい。
   ひとつ悪い要素があると、足し算より強く引きずられるということ。 */
check('ひとつ悪いと足し算より強く下がる', (() => {
  const d = at({ wind: 12 });
  const used = d.factors.filter((f) => f.applicable).map((f) => f.factor);
  const ari = used.reduce((a, b) => a + b, 0) / used.length;
  return d.value < ari - 0.005;
})(), `幾何 ${at({ wind: 12 }).value.toFixed(4)}`);

check('係数が 0 になることはない（幾何平均が潰れる）',
  SCORE_FACTORS.every((f) => {
    const probes = [null, 0, 0.5, 1, 3, 20, -5, 95, 65, 51];
    return probes.every((p) => {
      const v = f.of({ weatherCode: p, wind: p, flowRatio: p, pressureTrend: p,
        flow: p === null ? null : { key: 'slack' } });
      return v === null || (Number.isFinite(v) && v > 0);
    });
  }));

/* ---- 時間帯を点に入れていないか ---- */

/* **D-139 の判断そのもの。** 「シーバスでもデイゲームのほうが釣れる時があるし、
   フラットフィッシュも午前中が釣れるケースも多い」（本人）。
   狙う魚と釣り方で逆になるものを、アプリが一律に決めない。
   罠: マヅメを係数に戻すと、ここで落ちる。 */
check('係数に時間帯が無い',
  SCORE_FACTORS.every((f) => !/マヅメ|時間帯|朝|夕|夜/.test(`${f.label}${f.detail}`))
  && !SCORE_FACTORS.some((f) => f.key === 'band'),
  SCORE_FACTORS.map((f) => f.key).join(','));
check('band を渡しても点は変わらない',
  at({ band: 'morning' }).value === at({ band: 'day' }).value
  && at({ band: 'night' }).value === at({ band: 'day' }).value);

/* ---- 潮回りのラベルを見ていないか（D-137 から引き継ぎ） ---- */

check('説明に潮回りの語を書かない',
  SCORE_FACTORS.every((f) => !/大潮|中潮|小潮|長潮|若潮/.test(`${f.label}${f.detail}`)),
  SCORE_FACTORS.map((f) => f.detail).find((d) => /大潮/.test(d)) ?? '（無し）');

/* ---- 該当しない／材料が無い の扱い ---- */

/* **材料が無いものは分母から外す。**「1.0 で分母に残す」も考えたが、
   日の点は 24 時間の最大値なので、1.0 を混ぜてばらつきを縮めると
   最大値そのものが下がる。実測で日の★が ★2 44% に潰れた。
   罠: 1.0 で分母に残す形に戻すと、下の 2 件で落ちる。 */
check('材料が無い要素は分母から外す', (() => {
  const d = at({ pressureTrend: null });
  const p = facOf(d, 'press');
  if (!(p.applicable === true && p.known === false)) return false;
  const used = d.factors.filter((f) => f.known).map((f) => f.factor);
  const geo = used.reduce((a, b) => a * b, 1) ** (1 / used.length);
  return used.length === 4 && Math.abs(d.value - geo) < 1e-12;
})());
check('材料が減ってもばらつきは縮まない', (() => {
  // 風だけ変えたときの振れ幅が、気圧が取れない日でも小さくならない
  const span = (over) => at({ ...over, wind: 3 }).value - at({ ...over, wind: 12 }).value;
  return span({ pressureTrend: null }) >= span({}) - 1e-9;
})(), `全部そろい ${(at({ wind: 3 }).value - at({ wind: 12 }).value).toFixed(4)} / `
  + `気圧なし ${(at({ pressureTrend: null, wind: 3 }).value
      - at({ pressureTrend: null, wind: 12 }).value).toFixed(4)}`);

check('潮の効かない場所では潮を分母から外す', (() => {
  const d = at({ tideMatters: false });
  const used = d.factors.filter((f) => f.applicable).map((f) => f.key);
  return used.join(',') === 'wind,press,rain';
})());
/* 該当しないものを 1.0 で分母に残すと、風も気圧も効かなくなって全部 ★3 になる。
   実測でも、その置き方だと日の★の 66% が ★2 に潰れた。 */
check('潮の効かない場所でも風と気圧は効く', (() => {
  const a = at({ tideMatters: false, wind: 3 }).value;
  const b = at({ tideMatters: false, wind: 12 }).value;
  return a - b > 0.15;
})(), `${at({ tideMatters: false, wind: 3 }).value.toFixed(3)} vs `
  + `${at({ tideMatters: false, wind: 12 }).value.toFixed(3)}`);

/* ---- ★の切れ目 ---- */

check('日と時間で切れ目が違う', HOUR_CUTS.join(',') !== DAY_CUTS.join(','));
/* 日の点は 24 時間の最大値なので、時間の線をそのまま使うと上端に張り付く
   （実測で ★5 が 79%）。日の線のほうが高い位置にある。 */
check('日の切れ目のほうが高い', DAY_CUTS.every((c, i) => c > HOUR_CUTS[i]),
  `${HOUR_CUTS.join('/')} vs ${DAY_CUTS.join('/')}`);
check('同じ値でも日と時間で★が変わりうる', (() => {
  const v = 1.09;                                  // 時間なら ★5、日なら ★3
  return starFromValue(v, HOUR_CUTS) !== starFromValue(v, DAY_CUTS);
})(), `時間 ★${starFromValue(1.09, HOUR_CUTS)} / 日 ★${starFromValue(1.09, DAY_CUTS)}`);
check('切れ目は 5 段に割る',
  [0.5, 0.93, 0.98, 1.05, 1.09, 2].map((v) => starFromValue(v, HOUR_CUTS)).join(',')
  === '1,2,3,4,5,5');

/* ---- 折れ線の内挿 ---- */

check('表の内側は内挿する', Math.abs(curveAt([[0, 1], [10, 2]], 5) - 1.5) < 1e-9);
check('表の外側は端で頭打ち',
  curveAt([[0, 1], [10, 2]], -5) === 1 && curveAt([[0, 1], [10, 2]], 99) === 2);
check('数でなければ null', curveAt(WIND_CURVE, null) === null
  && curveAt(WIND_CURVE, 'x') === null);
/* 風は山なり。無風も強風も下がる（本人の体感: 0〜1 は弱すぎ、2〜3 が釣れやすい） */
check('風は山なり（無風も強風も下がる）', (() => {
  const peak = curveAt(WIND_CURVE, 3);
  return peak > curveAt(WIND_CURVE, 0) && peak > curveAt(WIND_CURVE, 12);
})(), [0, 3, 12].map((w) => `${w}m/s=${curveAt(WIND_CURVE, w).toFixed(2)}`).join(' '));

/* ---- 潮高比が約分されること（D-133 から引き継ぎ） ---- */

check('潮高比が違っても比は同じ（約分される）', (() => {
  const flow = { cmPerHour: 24 };
  const a = springFlowRatio(flow, { springFlow: 27, levelRatio: 1 });
  const b = springFlowRatio({ cmPerHour: 24 * 0.55 }, { springFlow: 27, levelRatio: 0.55 });
  return Math.abs(a - b) < 1e-9;
})());
check('基準を持たない観測所では null',
  springFlowRatio({ cmPerHour: 24 }, { levelRatio: 1 }) === null);

/* ---- 表示の値 ---- */

check('効いている要素には値がある', (() => {
  const d = at({});
  return d.factors.filter((f) => f.applicable && f.known).every((f) => f.value != null);
})(), at({}).factors.filter((f) => f.known && f.value == null).map((f) => f.key).join(','));
check('潮の値は「上げ4分 90%」の形（% を落とさない・D-138）',
  facOf(at({}), 'flow').value === '上げ4分 90%', facOf(at({}), 'flow').value);
check('気圧の符号は半角', facOf(at({ pressureTrend: 1.3 }), 'press').value === '+1.3hPa/3h',
  facOf(at({ pressureTrend: 1.3 }), 'press').value);

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
