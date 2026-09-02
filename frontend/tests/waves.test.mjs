/**
 * 波の帯と、波を取りに行くかの判断（D-142）のテスト。
 *   node frontend/tests/waves.test.mjs
 *
 * 遠州灘のサーフは「行ってみたら立てない」が起きる。行く前に分かるものを出す。
 *
 * ここで押さえるのは 4 つ。
 *   - 帯は**実測の分布から決めた**もので、勝手な丸い数字ではない
 *   - 波高だけでなく周期も見る（同じ 1.0m でも風波とうねりでは別物）
 *   - **外洋に面した場所でしか取りに行かない**。河川や管理釣り場で
 *     沖の波高を出しても読む意味が無く、要求が無駄になる
 *   - 材料が無いときは黙って出さない（0m と言わない）
 */
import { sliceApp } from './_slice.mjs';

/* windDirection（波の向きを言葉にする）から波の塊まで、まとめて 1 回で切る。
   2 回に分けると重なって「WAVE_BANDS が二重に宣言された」で落ちる（実際やった）。 */
const code = sliceApp([
  ['const WIND_DIRS', '/* ---------------- 天気の参照先（D-076）'],
]);
const {
  WAVE_BANDS, waveLevel, spotFacesOpenSea, describeWaves, waveSummary,
  OPEN_SEA_SPOT_TYPES, LONG_PERIOD_S,
} = new Function(code + `; return { WAVE_BANDS, waveLevel, spotFacesOpenSea,
  describeWaves, waveSummary, OPEN_SEA_SPOT_TYPES, LONG_PERIOD_S };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 帯 ---- */

/* 同笠沖 1 年 8760 時間の実測:
     5% 0.58 / 25% 0.82 / 50% 1.06 / 75% 1.46 / 90% 1.96 / 95% 2.48 / 最大 5.28m
   帯の切れ目はこの分位に合わせてある。**丸い数字を置いただけではない。**
   罠: 0.5/1.0/1.5/2.0 のような「きりのいい」値に変えると、ここで落ちる。 */
check('帯の切れ目が実測の分位に合っている',
  WAVE_BANDS.map((b) => b.max).join(',') === '0.8,1.2,1.6,2,',
  WAVE_BANDS.map((b) => b.max).join(','));
check('帯は 5 つ', WAVE_BANDS.length === 5);
check('いちばん上の帯に上限は無い（青天井を落とさない）',
  WAVE_BANDS.at(-1).max === null);

check('中央（1.06m）は「ふつう」', waveLevel(1.06).key === 'mid');
check('下位 25%（0.7m）は「穏やか」', waveLevel(0.7).key === 'calm');
check('上位 25%（1.5m）は「波っ気あり」', waveLevel(1.5).key === 'swell');
check('上位 10%（1.9m）は「荒れ気味」', waveLevel(1.9).key === 'rough');
check('2m 超は「荒れている」', waveLevel(2.4).key === 'storm');
check('観測史上の最大（5.28m）でも帯が出る', waveLevel(5.28).key === 'storm');
check('境目はその帯に入らない（0.8 は mid 側）', waveLevel(0.8).key === 'mid');
check('数でなければ null', waveLevel(null) === null && waveLevel('x') === null);

/* ---- 取りに行くかの判断 ---- */

/* **これを間違えると、要求が無駄になるか、サーフで波が出なくなる。**
   登録 27 件のうち 17 件が波の意味を持たない場所だった。 */
for (const t of ['surf', 'rock', 'port', 'tetra', 'cobble']) {
  check(`${t} では波を出す`, spotFacesOpenSea({ spot_type: t }) === true);
}
for (const t of ['river', 'lake', 'managed', 'rivermouth', 'tidalflat',
                 'brackish_lake', 'channel']) {
  check(`${t} では波を出さない`, spotFacesOpenSea({ spot_type: t }) === false);
}
check('スポットが無ければ出さない',
  spotFacesOpenSea(null) === false && spotFacesOpenSea({}) === false);
check('外洋に面する種別は 5 つ', OPEN_SEA_SPOT_TYPES.length === 5,
  OPEN_SEA_SPOT_TYPES.join(','));

/* ---- その日のまとめ ---- */

const hours = [
  { hour: 0, wave_height_m: 0.9, wave_period_s: 7.2, wave_direction_deg: 180 },
  { hour: 1, wave_height_m: 1.4, wave_period_s: 9.0, wave_direction_deg: 190 },
  { hour: 2, wave_height_m: 1.1, wave_period_s: 7.0, wave_direction_deg: 200 },
];
{
  const w = describeWaves(hours, 1);
  check('指定した時刻の波を返す', w.now === 1.4 && w.period === 9.0);
  check('その日の上下を返す', w.min === 0.9 && w.max === 1.4);
  check('帯は指定した時刻のもの', w.level.key === 'swell', w.level.key);
  check('向きは方角の言葉に直す', w.dirLabel === '南', w.dirLabel);
}
/* **長いうねりはその日のどこかにあれば言う。** 行く時刻を決める材料なので、
   いま短くても「今日は入る」と分かるほうがよい。
   罠: いまの時刻だけ見る作りにすると落ちる。 */
check(`その日のどこかに ${LONG_PERIOD_S}s 以上があれば言う`,
  describeWaves(hours, 0).longSwell === true);
check('どこにも無ければ言わない',
  describeWaves([{ hour: 0, wave_height_m: 1.0, wave_period_s: 6.0 }], 0).longSwell === false);

/* ---- 材料が無いとき ---- */

check('波が無ければ null', describeWaves([{ hour: 0, wave_height_m: null }], 0) === null);
check('予報そのものが無ければ null',
  describeWaves(null) === null && describeWaves([]) === null);
/* 0m と言い切らないこと。取れていないのと、凪いでいるのは違う */
check('取れていないときに 0m と言わない', describeWaves([], 0) === null);
check('周期と向きが無くても波高だけで出す', (() => {
  const w = describeWaves([{ hour: 0, wave_height_m: 1.0 }], 0);
  return w != null && w.now === 1.0 && w.period === null && w.dirLabel === null;
})());
check('指定した時刻が無ければ先頭で代用する',
  describeWaves(hours, 23).now === 0.9);

/* ---- 言葉にするところ（D-144） ----
   「いまの潮」の波の行と、ライブ映像に添える波の欄で**同じことを言う**。
   前は行のほうに直接書いていたので、片方だけ直せば必ず食い違う。
   数字の丸め方や「今日の幅を出すか」の判断はここにしか無い。 */
const sum = (h, atHour = 0) => waveSummary(describeWaves(h, atHour));

check('波が無ければ null', sum([{ hour: 0, wave_height_m: null }]) === null);
check('describeWaves が null でも落ちない', waveSummary(null) === null);

const one = sum([{ hour: 0, wave_height_m: 1.04, wave_period_s: 6.25,
                   wave_direction_deg: 180 }]);
/* **小数 1 桁に丸める。** 1.04m を 1.0m と出す。
   罠: 丸めずに出すと 1.04m のような桁が画面に並ぶ */
check('波高は小数 1 桁', one.height === '1.0', one.height);
check('周期も小数 1 桁', one.period === '6.3', one.period);
check('帯の名前と鍵を返す', one.band === 'ふつう' && one.bandKey === 'mid',
  `${one.band} / ${one.bandKey}`);
/* 帯の note は「その帯が実測でどのくらい珍しいか」。
   映像と見比べて目を慣らすための材料なので、必ず付いてくること */
check('帯の説明も返す', typeof one.note === 'string' && one.note.length > 0, one.note);
check('向きは言葉にする', one.dir === '南', one.dir);

/* **幅が 0.3m 未満なら書かない。** 「1.1〜1.2m」は読む手間のわりに何も言っていない。
   行く時刻を選ぶ材料になるのは、上下があるときだけ */
const flat = sum([{ hour: 0, wave_height_m: 1.1 }, { hour: 1, wave_height_m: 1.2 }]);
check('幅が狭ければ今日の幅を書かない', flat.range === null, String(flat.range));
const wide = sum([{ hour: 0, wave_height_m: 0.8 }, { hour: 1, wave_height_m: 1.9 }]);
check('幅があれば書く', wide.range === '0.8〜1.9m', String(wide.range));
// ちょうど 0.3m は書く側（境目を決めておく）
const edge = sum([{ hour: 0, wave_height_m: 1.0 }, { hour: 1, wave_height_m: 1.3 }]);
check('ちょうど 0.3m は書く', edge.range === '1.0〜1.3m', String(edge.range));

/* 長いうねりはその日のどこかにあれば言う（行く時刻を決める材料・D-142） */
const swell = sum([{ hour: 0, wave_height_m: 1.0, wave_period_s: 5.0 },
                   { hour: 1, wave_height_m: 1.0, wave_period_s: 9.0 }]);
check('長いうねりの日はそう書く',
  typeof swell.swell === 'string' && swell.swell.includes(`${LONG_PERIOD_S}秒`), swell.swell);
check('うねりが無ければ書かない',
  sum([{ hour: 0, wave_height_m: 1.0, wave_period_s: 5.0 }]).swell === null);

/* 周期や向きが取れないことはある。**そこだけ落として波高は出す** */
const bare = sum([{ hour: 0, wave_height_m: 2.2 }]);
check('周期と向きが無くても波高と帯は出す',
  bare.height === '2.2' && bare.bandKey === 'storm'
  && bare.period === null && bare.dir === null,
  JSON.stringify(bare));

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
