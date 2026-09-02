/**
 * 1 時間ごとの予報の読み方（D-104）のテスト。
 *   node frontend/tests/hourly.test.mjs
 *
 * ここは **間違えても画面は正常に見える** ところばかりなので、押さえておく。
 *   - windArrowDeg: 矢印が真逆でも「矢印が出ている」ようにしか見えない。
 *   - forecastSeries: モデルを 2 つ頼んだときの拾い方。片方が全部 null。
 *   - hoursFromNow: 起点を間違えると、過ぎた時間の予報を出し続ける。
 *   - rainOutlook: 1 行の結論。ここが外れると数字を見に行く意味がなくなる。
 *   - mapHourly: **1 時間値の時刻の意味**（D-111）。Open-Meteo は項目によって違う。
 *     気温は「その時刻の値」、雨量・天気記号・突風は「その時刻までの 1 時間」。
 *     読み違えると 1 時間ずれた予報を平然と出す（実際、16 時台に降って上がった雨を
 *     17:09 に「いま雨が降っています」と出した）。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import fs from 'node:fs';
import { sliceApp, END } from './_slice.mjs';


const code = sliceApp([
  ['export function forecastSeries', '/**\n * **複数地点**'],
  // windArrowDeg 以降は末尾まで（rainLevel / rainOutlook / mapHourly が要る）
  ['export function windArrowDeg', END],
], 'const WEATHER_MODEL_ORDER = ["jma_seamless", "best_match"];');

const { forecastSeries, mapHourly, windArrowDeg, windLevel, rainLevel, rainOutlook,
        hoursFromNow, uniqueHours } =
  new Function(code + `; return { forecastSeries, mapHourly, windArrowDeg,
                                  windLevel, rainLevel, rainOutlook,
                                  hoursFromNow, uniqueHours };`)();

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

/* 予想雨量の段階（D-111）。前は降水確率で分けていた */
eq('0.0mm は降らない', rainLevel(0).key, 'none');
eq('0.1mm から弱い雨', rainLevel(0.1).key, 'low');
eq('3mm から雨', rainLevel(3).key, 'mid');
eq('10mm から強い雨', rainLevel(10).key, 'high');
// 0 と「値が無い」は別物。0 を null 扱いにすると「降らない」が出せなくなる
eq('雨量が無ければ出さない', rainLevel(null), null);
eq('空文字でも出さない', rainLevel(''), null);

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
// 予想雨量だけで判断する（D-111）。降水確率は出すのをやめた
const mmRows = (list) => list.map((mm, i) => ({ hour: i, precip_mm: mm }));

eq('雨の予想が無ければそう書く', rainOutlook(mmRows([0, 0, 0, 0])).key, 'none');
check('何時間ぶん見たかを書く', rainOutlook(mmRows([0, 0, 0, 0])).text.includes('4 時間'),
  rainOutlook(mmRows([0, 0, 0, 0])).text);

/* **1 時間だけの弱い雨で見出しを出さない。**
   1 時間だけ 0.2mm の予想で「雨になりそう」と言うと、行くのをやめてしまう */
eq('1 時間だけ 0.2mm なら言い切らない', rainOutlook(mmRows([0, 0, 0.2, 0])).key, 'maybe');
check('少し降るかも、とは書く',
  rainOutlook(mmRows([0, 0, 0.2, 0])).text.includes('2時ごろに少し降るかもしれません'),
  rainOutlook(mmRows([0, 0, 0.2, 0])).text);
// 1 時間でも量があれば出す（通り雨）
check('1 時間でも量があれば出す',
  rainOutlook(mmRows([0, 0, 3.0, 0])).text.startsWith('2時ごろから'),
  rainOutlook(mmRows([0, 0, 3.0, 0])).text);
// 弱くても 2 時間続けば出す
check('弱くても 2 時間続けば出す',
  rainOutlook(mmRows([0, 0.2, 0.2, 0])).text.startsWith('1時ごろから'),
  rainOutlook(mmRows([0, 0.2, 0.2, 0])).text);
check('終わりと最大の量も出す',
  rainOutlook(mmRows([0, 0, 2.4, 3.1, 0])).text.includes('4時ごろまで')
  && rainOutlook(mmRows([0, 0, 2.4, 3.1, 0])).text.includes('3.1mm/h'),
  rainOutlook(mmRows([0, 0, 2.4, 3.1, 0])).text);

eq('雨量が 1 つも無ければ出さない', rainOutlook([{ hour: 0, precip_mm: null }]), null);
eq('空でも落ちない', rainOutlook([]), null);
eq('null でも落ちない', rainOutlook(null), null);

/* ---- 「いま」の書き方（D-111 で D-107 を直した） ----
   1 時間ぶんの予想雨量から「いま降っている」とは言えない。
   実際、16 時台に降って 17 時前に上がった雨を 17:09 に
   「いま雨が降っています」と書いて外した。**時間帯の予報として書く。** */
const nowRain = mmRows([1.2, 0.8, 0.3, 0, 0]);
eq('いまの時間帯が雨なら rain', rainOutlook(nowRain, { startsNow: true }).key, 'rain');
check('**「いま降っています」とは書かない**',
  !rainOutlook(nowRain, { startsNow: true }).text.includes('いま雨が降っています'),
  rainOutlook(nowRain, { startsNow: true }).text);
check('「◯時台は雨の予想です」と書く',
  rainOutlook(nowRain, { startsNow: true }).text.startsWith('0時台は雨の予想です'),
  rainOutlook(nowRain, { startsNow: true }).text);
check('**いつやむか**を書く',
  rainOutlook(nowRain, { startsNow: true }).text.includes('3時ごろにやみそう'),
  rainOutlook(nowRain, { startsNow: true }).text);
eq('やむ時刻も返す', rainOutlook(nowRain, { startsNow: true }).until.hour, 3);
// 同じ並びでも、先頭がいまでなければ「◯時ごろから」のまま
check('先の日なら「0時ごろから」',
  rainOutlook(nowRain).text.startsWith('0時ごろから'), rainOutlook(nowRain).text);

check('窓の端まで降り続くなら、やむ時刻は書かない',
  rainOutlook(mmRows([1.0, 1.0, 1.0]), { startsNow: true }).text.includes('降り続きそう')
  && rainOutlook(mmRows([1.0, 1.0, 1.0]), { startsNow: true }).until === null,
  rainOutlook(mmRows([1.0, 1.0, 1.0]), { startsNow: true }).text);

/* ---- 1 時間値の時刻の意味（D-111） ----
   **これが今回いちばん効いた取り違え。**
   Open-Meteo は気温を「その時刻の値」、雨量・天気記号・突風を
   「その時刻までの 1 時間」で返す。同じ 1 行の中で意味が違う。
   「H 時のカード」は H:00〜H+1:00 のことなので、区間の値は 1 つ後ろから取る。 */
const raw = {
  time: ['2026-08-12T16:00', '2026-08-12T17:00', '2026-08-12T18:00'],
  temperature_2m_jma_seamless: [29, 27, 26],
  precipitation_jma_seamless: [0.1, 2.6, 0.5],   // 17:00 の 2.6 は 16〜17 時に降ったぶん
  weather_code_jma_seamless: [3, 63, 61],
  wind_speed_10m_jma_seamless: [7, 7.7, 6.4],
  wind_direction_10m_jma_seamless: [90, 90, 90],
  wind_gusts_10m_jma_seamless: [12, 15, 13],
};
const mapped = mapHourly(raw);
eq('最後の 1 時間は落とす（区間の値が無いので）', mapped.length, 2);
eq('気温はその時刻の値のまま', mapped.map((r) => r.temp_c), [29, 27]);
eq('風速もその時刻の値のまま', mapped.map((r) => r.wind_speed_ms), [7, 7.7]);
// **16 時のカードの雨量は 16〜17 時ぶん = API の 17:00 の値**
eq('雨量は 1 つ後ろから取る', mapped.map((r) => r.precip_mm), [2.6, 0.5]);
eq('天気記号も 1 つ後ろから取る', mapped.map((r) => r.weather_code), [63, 61]);
eq('突風も 1 つ後ろから取る', mapped.map((r) => r.wind_gust_ms), [15, 13]);
// 取り違えていたときの値。ここに戻ったら気づけるようにしておく
check('**16 時台の雨を 17 時台のものとして出さない**',
  mapped[1].precip_mm !== 2.6, `17 時のカードの雨量 ${mapped[1].precip_mm}mm`);
eq('1 時間しか無ければそのまま返す（落とし切らない）',
  mapHourly({ time: ['2026-08-12T16:00'], precipitation_jma_seamless: [0.4] }).length, 1);

/* ---- 24 枚ちょうど出るか（D-114） ----
   潮汐詳細は「その日ぶん」と「翌日ぶん」をつないで渡す。
   週まとめの予報は**各日の末尾に翌日 0 時が足してある**ので、
   つなぐと 0 時が 2 枚になり、そのぶん最後の 1 時間が押し出される。
   21 時に見ると 24 枚目が 19 時（本人の指摘）。20 時まで出るのが期待値。

   **枚数だけ見ても気づけない**（重複ぶんで 24 枚は揃ってしまう）ので、
   最後の時刻まで見る。 */
const dayRows = (date) => Array.from({ length: 24 }, (_, h) =>
  ({ time: `${date}T${String(h).padStart(2, '0')}:00`, hour: h }));
// fetchWeatherRange が返す形。末尾に翌日 0 時が付く
const withNextMidnight = (date, next) => [...dayRows(date), dayRows(next)[0]];
const joined = [...withNextMidnight('2026-08-12', '2026-08-13'),
                ...withNextMidnight('2026-08-13', '2026-08-14')];

eq('つなぎ目の 0 時が 2 度出てこない',
  uniqueHours(joined).filter((h) => h.time === '2026-08-13T00:00').length, 1);
eq('まとめても順番と中身は変わらない',
  uniqueHours(joined).map((h) => h.time).slice(22, 26),
  ['2026-08-12T22:00', '2026-08-12T23:00', '2026-08-13T00:00', '2026-08-13T01:00']);
eq('重複が無ければそのまま', uniqueHours(dayRows('2026-08-12')).length, 24);
eq('null でも落ちない', uniqueHours(null), []);

const strip = (nowIso) => hoursFromNow(uniqueHours(joined), nowIso, 24);
eq('21 時に見たら 24 枚', strip('2026-08-12T21:00').length, 24);
eq('**21 時に見たら 20 時で終わる**（19 時ではない）',
  strip('2026-08-12T21:00').at(-1).time, '2026-08-13T20:00');
eq('0 時に見たら 23 時で終わる', strip('2026-08-12T00:00').at(-1).time, '2026-08-12T23:00');
eq('23 時に見たら翌日 22 時で終わる',
  strip('2026-08-12T23:00').at(-1).time, '2026-08-13T22:00');
// まとめずに渡すと、まさに指摘の症状になる。直っていることの裏取り
eq('まとめないと 19 時で終わっていた',
  hoursFromNow(joined, '2026-08-12T21:00', 24).at(-1).time, '2026-08-13T19:00');

/* ---- 日をまたいだら「明日の」を付ける（D-144・本人の指摘） ----
   帯は「これから 24 時間」なので、夕方に見ると後ろ半分は翌日になる。
   「2時ごろから雨になりそうです」とだけ書くと**今日の未明のことだと読める**。
   すでに過ぎた時刻なので、「もう降ったのか」と受け取ってしまう。

   カードのほうは上を走る日付の帯で分かるが、この 1 行には手がかりが無い。 */
const spanRows = (list, from = '2026-08-12T20:00') => {
  const start = Date.parse(`${from}:00Z`);
  return list.map((mm, i) => {
    const t = new Date(start + i * 3600000).toISOString();
    return { time: t.slice(0, 16), hour: Number(t.slice(11, 13)), precip_mm: mm };
  });
};

// 20 時起点。0.0 が 5 つで 1 時、そこから雨 → 翌日の 1 時
const overnight = spanRows([0, 0, 0, 0, 0, 2.4, 3.1, 0]);
check('**日をまたいだら「明日の」を付ける**',
  rainOutlook(overnight).text.startsWith('明日の1時ごろから'),
  rainOutlook(overnight).text);
check('やむ時刻にも付く',
  rainOutlook(overnight).text.includes('明日の3時ごろまで'),
  rainOutlook(overnight).text);
// 今日のうちに降るなら付けない。24 個の大半に要らない語が付くと読みにくい
check('同じ日なら付けない',
  rainOutlook(spanRows([0, 2.4, 3.1, 0])).text.startsWith('21時ごろから'),
  rainOutlook(spanRows([0, 2.4, 3.1, 0])).text);
// ぱらつく程度の言い方にも同じ規則で付く（言い方が 3 通りあるので全部見る）
check('「少し降るかも」にも付く',
  rainOutlook(spanRows([0, 0, 0, 0, 0, 0.2, 0])).text.startsWith('明日の1時ごろに少し'),
  rainOutlook(spanRows([0, 0, 0, 0, 0, 0.2, 0])).text);
// いま降っていて、やむのが翌日のとき
check('いまの雨がやむのが翌日なら、そこに付く',
  rainOutlook(spanRows([1.2, 1.2, 1.2, 1.2, 1.2, 0]), { startsNow: true })
    .text.includes('明日の1時ごろにやみそう'),
  rainOutlook(spanRows([1.2, 1.2, 1.2, 1.2, 1.2, 0]), { startsNow: true }).text);
// 窓の先頭が今日でなければ「明日」とは書けない（潮汐詳細は先の日を開ける）
check('先の日を開いているときは「明日」と書かない',
  rainOutlook(overnight, { today: '2026-08-10' }).text.startsWith('8/13 の1時ごろから'),
  rainOutlook(overnight, { today: '2026-08-10' }).text);
check('先頭が今日なら today を渡しても「明日の」',
  rainOutlook(overnight, { today: '2026-08-12' }).text.startsWith('明日の1時ごろから'),
  rainOutlook(overnight, { today: '2026-08-12' }).text);
// time を持たない行（古い呼び出し・テスト）でも落ちない
check('time が無くても落ちない',
  rainOutlook(mmRows([0, 0, 2.4, 3.1, 0])).text.startsWith('2時ごろから'),
  rainOutlook(mmRows([0, 0, 2.4, 3.1, 0])).text);

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
