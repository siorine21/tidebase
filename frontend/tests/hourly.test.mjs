/**
 * 1 時間ごとの予報の読み方（D-104）のテスト。
 *   node frontend/tests/hourly.test.mjs
 *
 * ここは **間違えても画面は正常に見える** ところばかりなので、押さえておく。
 *   - windArrowDeg: 矢印が真逆でも「矢印が出ている」ようにしか見えない。
 *   - forecastSeries: モデルを 2 つ頼んだときの拾い方。片方が全部 null。
 *   - hoursFromNow: 起点を間違えると、過ぎた時間の予報を出し続ける。
 *   - rainOutlook: 1 行の結論。ここが外れると数字を見に行く意味がなくなる。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = src.indexOf(from);
  const end = to ? src.indexOf(to, start) : src.length;
  if (start < 0 || end < 0) throw new Error(`切り出せない: ${from}`);
  return src.slice(start, end);
};
const code = [
  'const WEATHER_MODEL_ORDER = ["jma_seamless", "best_match"];',
  slice('export function forecastSeries', 'function mapHourly'),
  slice('export function windArrowDeg'),
].join('\n').replaceAll('export function', 'function').replaceAll('export const', 'const');

const { forecastSeries, windArrowDeg, windLevel, rainLevel, rainOutlook, hoursFromNow } =
  new Function(code + `; return { forecastSeries, windArrowDeg, windLevel, rainLevel,
                                  rainOutlook, hoursFromNow };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* ---- 風向きの矢印 ----
   予報の風向は「吹いてくる方角」。矢印は「吹いていく向き」に倒す。
   ここが 180 度ずれても画面は普通に見えるので、方角ごとに押さえる */
eq('北風（0°）＝北から南へ → 矢印は下（180°）', windArrowDeg(0), 180);
eq('東風（90°）＝東から西へ → 矢印は左（270°）', windArrowDeg(90), 270);
eq('南風（180°）＝南から北へ → 矢印は上（0°）', windArrowDeg(180), 0);
eq('西風（270°）＝西から東へ → 矢印は右（90°）', windArrowDeg(270), 90);
eq('北西（315°）→ 南東向き（135°）', windArrowDeg(315), 135);
eq('360 を超えても 0〜359 に収める', windArrowDeg(350), 170);
eq('負の値でも収める', windArrowDeg(-90), 90);
eq('数字でなければ出さない', windArrowDeg(null), null);
eq('文字列でも出さない', windArrowDeg('北西'), null);

/* ---- 2 つのモデルから拾う ---- */
const hourly = {
  time: ['2026-08-11T00:00', '2026-08-11T01:00', '2026-08-11T02:00'],
  weather_code_jma_seamless: [0, 1, 2],
  weather_code_best_match: [61, 61, 61],
  // 気象庁のモデルは降水確率を返さない。全部 null になる
  precipitation_probability_jma_seamless: [null, null, null],
  precipitation_probability_best_match: [10, 50, 80],
};
eq('気象庁のほうを優先する', forecastSeries(hourly, 'weather_code'), [0, 1, 2]);
eq('気象庁に無いものは既定で埋める',
  forecastSeries(hourly, 'precipitation_probability'), [10, 50, 80]);
// 1 時間ずつ見る。片方が途中だけ欠けても、そこだけ埋まってほしい
eq('欠けている時間だけ埋める', forecastSeries({
  time: ['a', 'b'], x_jma_seamless: [1, null], x_best_match: [9, 9] }, 'x'), [1, 9]);
eq('接尾辞なし（1 モデル）はそのまま', forecastSeries({ time: ['a'], x: [7] }, 'x'), [7]);
eq('どこにも無ければ null', forecastSeries(hourly, 'wave_height'), null);
eq('hourly が無くても落ちない', forecastSeries(null, 'x'), null);

/* ---- 区切り。釣行スコアと同じ数字にしてある ---- */
eq('5m/s は穏やか', windLevel(5).key, 'calm');
eq('5.1m/s はやや強い', windLevel(5.1).key, 'fresh');
eq('7m/s はまだやや強い', windLevel(7).key, 'fresh');
eq('7.1m/s は強い', windLevel(7.1).key, 'strong');
eq('10m/s はまだ強い', windLevel(10).key, 'strong');
eq('10.1m/s は強すぎ', windLevel(10.1).key, 'danger');
eq('風が無ければ出さない', windLevel(null), null);

eq('29% は降らなさそう', rainLevel(29).key, 'none');
eq('30% はにわか雨', rainLevel(30).key, 'low');
eq('50% は降りそう', rainLevel(50).key, 'mid');
eq('70% は降る', rainLevel(70).key, 'high');
eq('降水確率が無ければ出さない', rainLevel(null), null);

/* ---- これから先だけを取り出す ---- */
const twoDays = [];
for (const d of ['2026-08-11', '2026-08-12']) {
  for (let h = 0; h < 24; h++) {
    twoDays.push({ time: `${d}T${String(h).padStart(2, '0')}:00`, hour: h });
  }
}
eq('いまの時刻から始まる',
  hoursFromNow(twoDays, '2026-08-11T21:30', 4).map((h) => h.time),
  ['2026-08-11T21:00', '2026-08-11T22:00', '2026-08-11T23:00', '2026-08-12T00:00']);
eq('ちょうどの時刻はその時間から', hoursFromNow(twoDays, '2026-08-11T21:00', 1)[0].time,
  '2026-08-11T21:00');
eq('24 時間ぶん取れる', hoursFromNow(twoDays, '2026-08-11T21:00', 24).length, 24);
// 予報の範囲より先の時刻を渡したとき、過去を出すくらいなら空のほうがいい
eq('予報の外なら空', hoursFromNow(twoDays, '2026-09-01T00:00', 4), []);
eq('予報の前なら先頭から', hoursFromNow(twoDays, '2026-08-01T00:00', 2).map((h) => h.time),
  ['2026-08-11T00:00', '2026-08-11T01:00']);
eq('空でも落ちない', hoursFromNow([], '2026-08-11T21:00'), []);

/* ---- 1 行の結論 ---- */
// 降水量が届かない経路（古いキャッシュなど）。確率だけで判断する
const withPop = (list) => list.map((p, i) => ({ hour: i, precip_chance: p }));
// 降水量つき（本来の経路）。[確率, mm] の組で渡す
const withMm = (list) => list.map(([p, mm], i) => ({ hour: i, precip_chance: p, precip_mm: mm }));

eq('全部低ければ「心配は少ない」', rainOutlook(withPop([0, 5, 10, 2])).key, 'none');
check('最大値も出す', rainOutlook(withPop([0, 5, 10, 2])).text.includes('10%'),
  rainOutlook(withPop([0, 5, 10, 2])).text);

// 1 時間だけ跳ねた値で「雨になる」と言わない。次の時間も続いていることを見る
eq('1 時間だけ 60% なら「かもしれない」', rainOutlook(withPop([0, 0, 60, 0])).key, 'maybe');
eq('2 時間続けば「雨になりそう」', rainOutlook(withPop([0, 0, 60, 55])).key, 'rain');
check('何時からかを出す', rainOutlook(withPop([0, 0, 60, 55])).text.includes('2時'),
  rainOutlook(withPop([0, 0, 60, 55])).text);
check('いちばん高い時刻も出す', rainOutlook(withPop([0, 0, 60, 90])).text.includes('3時'),
  rainOutlook(withPop([0, 0, 60, 90])).text);
eq('30% 台だけなら「にわか雨」', rainOutlook(withPop([0, 35, 35, 0])).key, 'maybe');

eq('降水確率が 1 つも無ければ出さない',
  rainOutlook([{ hour: 0, precip_chance: null }]), null);
eq('空でも落ちない', rainOutlook([]), null);
eq('null でも落ちない', rainOutlook(null), null);

/* ---- 「いま」と「量」（D-107） ----
   12:05 に見て「12 時ごろから雨になりそうです」と出ていた。
   先頭がいまの時間帯なら、始まりではなく**いま降っていること**と**終わり**を出す。 */
const nowRain = withMm([[94, 1.2], [91, 0.8], [86, 0.3], [82, 0], [80, 0]]);
eq('いま降っているなら「いま雨」', rainOutlook(nowRain, { startsNow: true }).key, 'rain');
check('「いま雨が降っています」と書く',
  rainOutlook(nowRain, { startsNow: true }).text.startsWith('いま雨が降っています'),
  rainOutlook(nowRain, { startsNow: true }).text);
check('**いつやむか**を書く',
  rainOutlook(nowRain, { startsNow: true }).text.includes('3時ごろにやみそう'),
  rainOutlook(nowRain, { startsNow: true }).text);
eq('やむ時刻も返す', rainOutlook(nowRain, { startsNow: true }).until.hour, 3);
// 同じ並びでも、先頭がいまでなければ「◯時ごろから」のまま
check('先の日なら「0時ごろから」',
  rainOutlook(nowRain).text.startsWith('0時ごろから'), rainOutlook(nowRain).text);

const allRain = withMm([[90, 1.0], [90, 1.0], [90, 1.0]]);
check('窓の端まで降り続くなら、やむ時刻は書かない',
  rainOutlook(allRain, { startsNow: true }).text.includes('降り続きそう')
  && rainOutlook(allRain, { startsNow: true }).until === null,
  rainOutlook(allRain, { startsNow: true }).text);

// いまは降っていないが、あとで降る
const later = withMm([[40, 0], [60, 0], [85, 2.4], [85, 3.1], [50, 0]]);
check('あとで降るなら「◯時ごろから」',
  rainOutlook(later, { startsNow: true }).text.startsWith('2時ごろから'),
  rainOutlook(later, { startsNow: true }).text);
check('終わりと最大の量も出す',
  rainOutlook(later, { startsNow: true }).text.includes('4時ごろまで')
  && rainOutlook(later, { startsNow: true }).text.includes('3.1mm/h'),
  rainOutlook(later, { startsNow: true }).text);

/* **確率は高いのに量はゼロ**。蒸し暑い不安定な空でよく出る。
   ここで「雨になりそう」と言うと、モデルが降ると言っていない雨を宣言してしまう。
   実際 2026-08-12 の遠州灘がこれで、94% ・ 0.0mm だった。 */
const popOnly = withMm([[94, 0], [91, 0], [86, 0], [82, 0]]);
eq('量がゼロなら言い切らない', rainOutlook(popOnly, { startsNow: true }).key, 'maybe');
check('確率が高いことは伝える',
  rainOutlook(popOnly, { startsNow: true }).text.includes('94%')
  && rainOutlook(popOnly, { startsNow: true }).text.includes('まとまった雨の予想はありません'),
  rainOutlook(popOnly, { startsNow: true }).text);
// 0.05mm のような端数で「降っている」と言わない
eq('ごく少ない量は降っていない扱い',
  rainOutlook(withMm([[80, 0.05], [80, 0.05]]), { startsNow: true }).key, 'maybe');

/* **1 時間だけの弱い雨で見出しを出さない。** 確率のときと同じ考え方。
   実際 2026-08-12 の遠州灘は、21 時に 0.2mm が 1 時間だけ立っていた。
   これで「21 時ごろから雨になりそう」と出すと、行くのをやめてしまう。 */
eq('1 時間だけ 0.2mm なら見出しにしない',
  rainOutlook(withMm([[90, 0], [90, 0], [84, 0.2], [80, 0]]), { startsNow: true }).key, 'maybe');
// 量がまとまっていれば 1 時間でも出す（通り雨）
check('1 時間でも量があれば出す',
  rainOutlook(withMm([[40, 0], [40, 0], [84, 3.0], [40, 0]]), { startsNow: true })
    .text.startsWith('2時ごろから'),
  rainOutlook(withMm([[40, 0], [40, 0], [84, 3.0], [40, 0]]), { startsNow: true }).text);
// 弱くても 2 時間続けば出す
check('弱くても 2 時間続けば出す',
  rainOutlook(withMm([[40, 0], [84, 0.2], [84, 0.2], [40, 0]]), { startsNow: true })
    .text.startsWith('1時ごろから'),
  rainOutlook(withMm([[40, 0], [84, 0.2], [84, 0.2], [40, 0]]), { startsNow: true }).text);
// いま降っているなら、弱くても 1 時間でも言う（もう濡れているので）
check('いまの雨は弱くても言う',
  rainOutlook(withMm([[84, 0.2], [40, 0], [40, 0]]), { startsNow: true })
    .text.startsWith('いま雨が降っています'),
  rainOutlook(withMm([[84, 0.2], [40, 0], [40, 0]]), { startsNow: true }).text);

// 量が届いていない経路では、いままでどおり確率で判断する
check('量が無ければ確率で判断（いま降っている）',
  rainOutlook(withPop([80, 80, 20]), { startsNow: true }).text.startsWith('いま雨が降っていそう'),
  rainOutlook(withPop([80, 80, 20]), { startsNow: true }).text);

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
