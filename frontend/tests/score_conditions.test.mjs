/**
 * 釣行スコアの決め方（D-135）のテスト。
 *   node frontend/tests/score_conditions.test.mjs
 *
 * 組み合わせ表（大潮＋晴れ＋風 5m/s 以下 → ★5）をやめ、
 * **荒天のゲート**と**良い条件がそろった割合**の 2 段にした。
 * 実データ 112 日で測ると、前の式は 97% の日が ★4 か ★5 になっていて、
 * 日を選ぶ材料になっていなかった。
 *
 * ここで押さえるのは 4 つ。
 *   - 荒天はそれだけで決まる（良い条件がいくつ揃っていても持ち上げない）
 *   - 潮回りのラベルを見ていない（実際の流速で見る）
 *   - **材料が無い条件は「外れ」ではなく「対象外」**。分母から外す。
 *     外れ扱いにすると、潮の無い場所や気圧の取れない時間帯が黙って低くなる
 *   - 潮高比は約分されて点に入らない（D-133）
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['export function weatherCategory', 'const WIND_DIRS'],
  ['/* 釣行スコアの決め方（D-135', 'export function fishingScore('],
  ['export function springFlowRatio', '/**\n * 1 時間ごとの点を出す関数を作る（D-116）。'],
]);
const {
  fishingScoreDetail, scoreFromHits, springFlowRatio,
  SCORE_CONDITIONS, STRONG_FLOW_RATIO,
} = new Function(code + `; return { fishingScoreDetail, scoreFromHits, springFlowRatio,
  SCORE_CONDITIONS, STRONG_FLOW_RATIO };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/** 良い条件が全部そろった 1 時間 */
const perfect = {
  weatherCode: 0, wind: 3,
  flowRatio: 0.9, flow: { key: 'start', direction: '上げ潮', cmPerHour: 24 },
  band: 'morning', pressureTrend: -2, tideMatters: true,
};
const at = (over) => fishingScoreDetail({ ...perfect, ...over });

/* ---- 荒天のゲート ---- */

check('雷雨はそれだけで ★1', at({ weatherCode: 95 }).score === 1, String(at({ weatherCode: 95 }).score));
check('15m/s 以上はそれだけで ★1', at({ wind: 16 }).score === 1);
check('雨はそれだけで ★2', at({ weatherCode: 63 }).score === 2, String(at({ weatherCode: 63 }).score));
check('10m/s 超はそれだけで ★2', at({ wind: 11 }).score === 2);
check('ゲートに当たったら、良い条件では持ち上げない',
  at({ weatherCode: 63 }).score === 2 && at({ weatherCode: 63 }).gate != null);
check('ゲートの理由が分かる',
  at({ weatherCode: 95 }).gate?.label?.includes('雷雨') === true, at({ weatherCode: 95 }).gate?.label);
check('荒天でなければゲートは無い', at({}).gate === null);

/* ---- そろった割合 ---- */

check('5/5 そろえば ★5', at({}).score === 5 && at({}).hits === 5, JSON.stringify([at({}).hits, at({}).applicable]));
check('4/5 で ★5（8 割）', at({ pressureTrend: 0 }).score === 5, String(at({ pressureTrend: 0 }).score));
check('3/5 で ★4（6 割）',
  at({ pressureTrend: 0, band: 'day' }).score === 4, String(at({ pressureTrend: 0, band: 'day' }).score));
check('2/5 で ★3',
  at({ pressureTrend: 0, band: 'day', wind: 0.5 }).score === 3);
check('0/5 でも ★3 より下がらない（荒天でなければ釣りにはなる）',
  at({ pressureTrend: 3, band: 'day', wind: 0.5, flowRatio: 0.1,
       flow: { key: 'slack', direction: '潮止まり', cmPerHour: 1 } }).score === 3);
check('割合の表', [scoreFromHits(4, 5), scoreFromHits(3, 5), scoreFromHits(2, 5),
                   scoreFromHits(3, 3), scoreFromHits(2, 3), scoreFromHits(1, 3)]
  .join(',') === '5,4,3,5,4,3');

/* ---- 風は山型（0〜1 は弱すぎる） ---- */

const windHit = (ms) => at({ wind: ms }).conditions.find((c) => c.key === 'wind').hit;
check('0.5m/s は弱すぎて当たらない', windHit(0.5) === false);
check('2m/s は当たる', windHit(2) === true);
check('3m/s は当たる', windHit(3) === true);
check('5m/s は当たる', windHit(5) === true);
check('6m/s は外れる', windHit(6) === false);

/* ---- 潮回りのラベルを見ていない ---- */

/* 「大潮」の語は flow の説明に出るが、これは**基準の呼び名**（その場所の
   大潮でいちばん速いとき）であって、点の入力ではない。
   入力として効いていないことを、渡してみて確かめる。 */
check('潮回りを渡しても点が変わらない（ラベルは見ていない）',
  ['大潮', '中潮', '小潮', '長潮', null]
    .map((t) => fishingScoreDetail({ ...perfect, tideType: t }).score)
    .every((v, _, a) => v === a[0]),
  ['大潮', '小潮'].map((t) => fishingScoreDetail({ ...perfect, tideType: t }).score).join(' / '));
check('条件は 5 つで、潮の 2 つだけが潮汐に依存する',
  SCORE_CONDITIONS.length === 5
  && SCORE_CONDITIONS.filter((c) => c.tide).map((c) => c.key).join(',') === 'flow,start',
  SCORE_CONDITIONS.map((c) => `${c.key}${c.tide ? '*' : ''}`).join(','));

/* ---- 対象外の扱い（ここが本題） ---- */

{
  // 潮の効かない場所。潮の 2 条件は分母から外れる
  const d = fishingScoreDetail({ ...perfect, tideMatters: false });
  check('潮が効かない場所では対象が 3 つになる', d.applicable === 3, String(d.applicable));
  check('それでも ★5 に届く（外れ扱いで頭打ちにしない）', d.score === 5, String(d.score));
  check('潮の条件は対象外と分かる',
    d.conditions.filter((c) => !c.applicable).map((c) => c.key).join(',') === 'flow,start');
}
{
  /* 大潮基準を持っていない観測所。**外れ扱いにはしない。**
     測れないことを理由に点を下げるのは、材料が無いことと条件が悪いことを
     混ぜている。分母から外して「判定できたぶんのうち何割か」で見る。 */
  const d = at({ flowRatio: null });
  check('基準が無ければ潮の強さは対象外',
    d.applicable === 4 && d.conditions.find((c) => c.key === 'flow').applicable === false,
    JSON.stringify([d.hits, d.applicable]));
  check('残りが全部そろっていれば ★5 のまま（下がらない）', d.score === 5, String(d.score));
  // 逆に、対象外にせず外れ扱いにしていたら 4/5 = ★5 のまま…ではなく分母が 5 のまま
  check('分母が 5 のままになっていない（外れ扱いになっていない）',
    d.applicable !== 5, `applicable=${d.applicable}`);
}
{
  // 気圧が取れない時間帯（窓の先頭 3 時間）
  const d = at({ pressureTrend: null });
  check('気圧が無ければ対象外', d.applicable === 4 && d.hits === 4);
  check('4/4 なので ★5 のまま（下がらない）', d.score === 5, String(d.score));
}

/* ---- 潮高比は点に入らない（D-133） ---- */
{
  const flow = { key: 'start', direction: '上げ潮', cmPerHour: 24 };
  const base = { springFlow: 27 };
  const open = springFlowRatio(flow, { ...base, levelRatio: 1 });
  // 潮高比 0.55 の地点では、潮位も流速も 0.55 倍になる
  const inner = springFlowRatio(
    { ...flow, cmPerHour: 24 * 0.55 }, { ...base, levelRatio: 0.55 });
  check('潮高比が違っても比は同じ（約分される）',
    Math.abs(open - inner) < 1e-9, `${open.toFixed(3)} vs ${inner.toFixed(3)}`);
  check('基準を持たない観測所では null',
    springFlowRatio(flow, { levelRatio: 1 }) === null);
  check('流速が無ければ null', springFlowRatio(null, { ...base, levelRatio: 1 }) === null);
  check('しきい値は大潮の 6 割', STRONG_FLOW_RATIO === 0.6);
}

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
