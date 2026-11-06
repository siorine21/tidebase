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

/* ---- 何時の値か・うねり（D-183） ----
   本人の要望「畳んだ部分に波だけではなくうねりの具合も。何時時点のものかも」。
   数字は 2026-11-06 の同笠沖（実際に取ったもの）。合わせた波 2.1m のうち、
   うねりが 1.6m（8.6 秒・南東）で、残りは西からの風波だった */
const sea = [
  { hour: 13, wave_height_m: 2.2, wave_period_s: 8.0, wave_direction_deg: 186,
    swell_height_m: 1.68, swell_period_s: 8.6, swell_direction_deg: 149 },
  { hour: 14, wave_height_m: 2.12, wave_period_s: 7.9, wave_direction_deg: 189,
    swell_height_m: 1.58, swell_period_s: 8.55, swell_direction_deg: 149 },
];
{
  const w = describeWaves(sea, 14);
  check('使った行の時刻を返す', w.hour === 14, String(w.hour));
  check('うねりはその時刻のもの（高さ・周期・向き）',
    w.swellHeight === 1.58 && w.swellPeriod === 8.55 && w.swellDirLabel === '南東',
    JSON.stringify([w.swellHeight, w.swellPeriod, w.swellDirLabel]));
}
/* **頼んだ時刻ではなく、実際に使った行の時刻。** 23 時の行が無くて先頭（13 時）で
   代用したのに「23:00」と書くと、13 時の数字に嘘の時刻が付く。
   罠: 頼まれた時刻（atHour）をそのまま返すと落ちる */
check('**代用した行なら、その行の時刻を言う**（頼まれた時刻ではない）',
  describeWaves(sea, 23).hour === 13, String(describeWaves(sea, 23).hour));
check('時刻の分からない行なら時刻は null',
  describeWaves([{ wave_height_m: 1.0 }]).hour === null);

const s14 = sum(sea, 14);
check('時刻は「14:00」の形', s14.at === '14:00', s14.at);
check('1 桁の時は 0 を補う（「09:00」）。文字の幅がそろう',
  sum([{ hour: 9, wave_height_m: 1.0 }], 9).at === '09:00');
check('0 時も「00:00」（0 を「無い」と取り違えない）',
  sum([{ hour: 0, wave_height_m: 1.0 }], 0).at === '00:00');
check('時刻が分からなければ at は null', sum([{ wave_height_m: 1.0 }]).at === null);
check('うねりも小数 1 桁（1.58m → 1.6m・8.55 秒 → 8.6 秒）',
  s14.swellWave.height === '1.6' && s14.swellWave.period === '8.6', JSON.stringify(s14.swellWave));
check('うねりの向きも言葉にする', s14.swellWave.dir === '南東', s14.swellWave.dir);
/* **うねりに波の帯は当てない。** 帯は合わせた波高の分布で切ってある。
   うねりは同笠沖 1 年の中央が 0.78m で、当てると「ふつう」のうねりが「穏やか」になる。
   罠: waveLevel をうねりに通して帯を付けると、ここで落ちる */
check('うねりには帯を付けない（高さ・周期・向きだけ）',
  Object.keys(s14.swellWave).join(',') === 'height,period,dir', Object.keys(s14.swellWave).join(','));
/* **0m と「取れていない」は別物**（D-142 と同じ）。 */
check('うねりの列が無ければ null（0m と言わない）',
  sum([{ hour: 0, wave_height_m: 1.0 }]).swellWave === null);
check('うねりが 0m なら「0.0」と言う（無いのとは別）',
  sum([{ hour: 0, wave_height_m: 0.5, swell_height_m: 0 }]).swellWave?.height === '0.0');
check('周期と向きだけ無くても、うねりの高さは出す', (() => {
  const s = sum([{ hour: 0, wave_height_m: 1.0, swell_height_m: 0.7 }]).swellWave;
  return s?.height === '0.7' && s.period === null && s.dir === null;
})());
/* スポットの予報（fetchWeather）はうねりの列を頼んでいない。
   「いまの潮」の波の行がこれまでどおりであること */
check('スポットの予報（うねりの列なし）では、うねりを出さない',
  sum(hours, 1).swellWave === null && sum(hours, 1).height === '1.4');

/* ---- marine の行への写し方（D-183） ----
   列の名前（swell_wave_*）と行の名前（swell_*）が違うので、写し間違えると
   黙って null になり、うねりだけ一度も出ない。本物の応答の形で確かめる */
{
  const prelude = `
    const urls = [];
    async function fetchWithTimeout(url) {
      urls.push(url);
      return { ok: true, json: async () => ({ hourly: {
        time: ["2026-11-06T13:00", "2026-11-06T14:00"],
        wave_height: [2.2, 2.12], wave_period: [8.0, 7.9], wave_direction: [186, 189],
        swell_wave_height: [1.68, 1.58], swell_wave_period: [8.6, 8.55], swell_wave_direction: [149, 149],
      } }) };
    }`;
  const fetchCode = sliceApp([
    ['/* ライブ映像に添える波（D-144）。**波だけを取りに行く。**', 'async function fetchWeatherUncached'],
  ], prelude);
  const { fetchWaves, urls } = new Function(fetchCode + '; return { fetchWaves, urls };')();
  const rows = await fetchWaves(34.63, 137.93, '2026-11-06');
  check('うねりの列を行に写す（高さ・周期・向き）',
    rows[1].swell_height_m === 1.58 && rows[1].swell_period_s === 8.55 && rows[1].swell_direction_deg === 149,
    JSON.stringify(rows[1]));
  check('写した行から、そのまま見出しの数字になる',
    JSON.stringify(waveSummary(describeWaves(rows, 14)).swellWave) === JSON.stringify({ height: '1.6', period: '8.6', dir: '南東' }));
  const hourly = new URL(urls[0]).searchParams.get('hourly').split(',');
  check('**うねりの列も同じ 1 本で頼む**',
    urls.length === 1 && ['swell_wave_height', 'swell_wave_period', 'swell_wave_direction'].every((c) => hourly.includes(c)),
    hourly.join(','));
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
