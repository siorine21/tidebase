/**
 * 今日のおすすめスポットの選び方・並べ方（D-160）のテスト。
 *   node frontend/tests/recommend.test.mjs
 *
 * **ここは「行けない場所を推す」と「実績で★を動かす」を止めるところ。**
 *
 * 押さえるのは 5 つ。
 *   - 管理釣り場と、**潮汐の効かない場所**は出さない（本人の要望）
 *     「渓流」はスキーマに無い。water_type='freshwater' で切ると渓流は
 *     1 件も除けないまま、汽水のスポットを巻き添えにする（二瀬北）
 *   - 遠征先は出さない。ただし**距離が分からないものは残す**
 *     （基準スポット未設定で候補が全部消えるほうが困る）
 *   - 並びは**条件の★順**。実績は同点のときだけ効く
 *   - 実績が無い場所に「0 回」と書かない。**まだ行っていない ≠ 釣れない**
 *   - 潮位置が分からなければ、その行を出さない
 */
import { sliceApp } from './_slice.mjs';

const prelude = `
  function isCoordinateInJapan(lat, lng) {
    const a = Number(lat), b = Number(lng);
    return Number.isFinite(a) && Number.isFinite(b)
      && a >= 20 && a <= 46 && b >= 122 && b <= 154;
  }
  function todayInJst() { return "2026-09-22"; }
  const WEEKDAYS_EN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
`;

const code = sliceApp([
  'export function formatJstDate(isoDate',
  'export function hoursFromHhmm(hhmm)',
  ['export const OUTING_GAP_HOURS', 'export const RECORD_LIST_COLUMNS'],
], prelude);

const app = new Function(code + `; return { recommendSpots, isRecommendable, distanceKm,
  historyLine, phaseLine, groupOutings, spotHistory };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/* 浜松あたり。基準は 34.70 / 137.73 */
const BASE = { latitude: 34.70, longitude: 137.73 };
const spot = (o = {}) => ({
  id: "sp1", name: "はまぼう公園", spot_type: "rivermouth", water_type: "brackish",
  tide_station_code: "MI", latitude: 34.70, longitude: 137.73, ...o,
});

/* ================================================================
   出してはいけない場所
   ================================================================ */
{
  eq('ふつうのスポットは出す', app.isRecommendable(spot()), true);
  eq('**管理釣り場は出さない**',
    app.isRecommendable(spot({ spot_type: "managed", tide_station_code: null })), false);
  eq('海の近くの管理釣り場でも出さない',
    app.isRecommendable(spot({ spot_type: "managed" })), false);
  eq('**潮汐地点が無ければ出さない**（渓流はここに入る）',
    app.isRecommendable(spot({ spot_type: "river", tide_station_code: null })), false);
  eq('座標が無ければ出さない',
    app.isRecommendable(spot({ latitude: null, longitude: null })), false);
  eq('国外の座標は出さない',
    app.isRecommendable(spot({ latitude: 37.7, longitude: -122.4 })), false);
  eq('null でも落ちない', app.isRecommendable(null), false);

  /* **二瀬北の巻き添えを起こさない。** 淡水と書かれているが潮汐地点がある
     （＝感潮）なら出す。water_type では切らない */
  eq('淡水でも潮汐地点があれば出す',
    app.isRecommendable(spot({ water_type: "freshwater", spot_type: "river" })), true);
}

/* ================================================================
   距離
   ================================================================ */
{
  const d = app.distanceKm(BASE, { latitude: 34.70, longitude: 137.73 });
  check('同じ場所は 0km', d != null && d < 0.01, String(d));
  const tokyo = app.distanceKm(BASE, { latitude: 35.68, longitude: 139.77 });
  check('東京まではおよそ 200km', tokyo > 180 && tokyo < 230, String(Math.round(tokyo)));
  eq('座標が無ければ null', app.distanceKm(BASE, { latitude: null, longitude: null }), null);
}

const scoresOf = (m) => new Map(Object.entries(m).map(([k, v]) => [k, { score: v, best: {} }]));

{
  const spots = [
    spot({ id: "near", name: "近いところ", latitude: 34.70, longitude: 137.73 }),
    spot({ id: "far", name: "三浦半島城ヶ島", latitude: 35.13, longitude: 139.61 }),
    spot({ id: "nogeo", name: "座標なし", latitude: null, longitude: null }),
  ];
  const got = app.recommendSpots({
    spots, scores: scoresOf({ near: 3, far: 5, nogeo: 5 }), outings: [],
    today: "2026-09-22", from: BASE });
  eq('**遠征先は出さない**', got.map((r) => r.spot.id), ["near"]);

  /* 基準が無いときに全部消えてはいけない */
  const noBase = app.recommendSpots({
    spots, scores: scoresOf({ near: 3, far: 5, nogeo: 5 }), outings: [],
    today: "2026-09-22", from: null });
  eq('基準が無ければ距離で切らない', noBase.map((r) => r.spot.id), ["far", "near"]);
}

/* ★が出せないものは推さない */
{
  const spots = [spot({ id: "a", name: "あ" }), spot({ id: "b", name: "い" })];
  const got = app.recommendSpots({
    spots, scores: scoresOf({ a: 4 }), outings: [], today: "2026-09-22" });
  eq('★の無いスポットは出さない', got.map((r) => r.spot.id), ["a"]);
}

/* ================================================================
   並びは条件の★順。**実績で★を動かさない**
   ================================================================ */
{
  let seq = 0;
  const rec = (o) => ({
    id: `r${seq++}`, user_id: "u1", owner_name: "タツマ", spot_id: "low",
    fished_at: "2026-09-10", fished_time: "09:00:00", outcome: "landed",
    catch_count: 1, length_cm: 60, fish_label: "マルスズキ",
    tide_phase_tenth: 9, tide_phase_rising: false, ...o,
  });
  // 実績は「low」に山盛り、★は「high」のほうが上
  const outings = app.groupOutings([
    rec({ fished_at: "2026-09-01" }), rec({ fished_at: "2026-09-05" }),
    rec({ fished_at: "2026-09-12" }), rec({ fished_at: "2026-09-15" }),
  ]);
  const spots = [
    spot({ id: "low", name: "実績はあるが条件が悪い" }),
    spot({ id: "high", name: "条件がよい" }),
  ];
  const got = app.recommendSpots({
    spots, scores: scoresOf({ low: 2, high: 5 }), outings, today: "2026-09-22" });
  eq('**★の高いほうが上。実績では順位が動かない**',
    got.map((r) => r.spot.id), ["high", "low"]);
  eq('  実績は付いている', got[1].history.seasonCaught, 4);

  // ★が同点なら、実績の多いほうが上
  const tie = app.recommendSpots({
    spots, scores: scoresOf({ low: 5, high: 5 }), outings, today: "2026-09-22" });
  eq('★が同点なら実績の多いほうが上', tie.map((r) => r.spot.id), ["low", "high"]);
}

/* 出す件数を守る */
{
  const spots = [1, 2, 3, 4, 5].map((i) => spot({ id: `s${i}`, name: `s${i}` }));
  const scores = scoresOf({ s1: 5, s2: 4, s3: 3, s4: 2, s5: 1 });
  eq('既定は 3 件',
    app.recommendSpots({ spots, scores, today: "2026-09-22" }).map((r) => r.spot.id),
    ["s1", "s2", "s3"]);
}

/* ================================================================
   文言
   ================================================================ */
{
  const h = {
    seasonCaught: 3, seasonOutings: 4, bestFish: 8, bestLengthCm: 20,
    bestSpecies: "メッキ", band: "下げ終わり", samePhase: 3,
    last: { date: "2026-09-19", ownerName: "タツマ" },
  };
  const parts = app.historyLine(h);
  check('**区切りごとの配列で返る**（折り返しを区切りに寄せるため）',
    Array.isArray(parts), JSON.stringify(parts));
  const line = parts.join(" ／ ");
  check('回数が出る', line.includes("この時期に 3 回"), line);
  check('**連発が出る**（単発 3 回と区別が付く）', line.includes("最大 8 匹"), line);
  check('サイズと魚種が出る', line.includes("メッキ 20cm"), line);
  check('**誰の実績かが出る**', line.includes("タツマ"), line);
  check('率を書かない', !/[%％]/.test(line) && !/\d+\s*\/\s*\d+/.test(line), line);
  /* **日付と誰の実績かを、同じ区切りに入れておく。**
     別々の区切りにすると、そこで折り返せてしまう */
  check('日付と名前は同じ区切りに入る',
    parts.some((p) => p.includes("09.19") && p.includes("タツマ")), JSON.stringify(parts));

  eq('潮位置の行', app.phaseLine(h), "いまと同じ潮位置（下げ終わり）で 3 回");
}

/* 単発しかない場所では「最大 1 匹」と書かない（当たり前のことを書かない） */
{
  const line = app.historyLine({
    seasonCaught: 2, bestFish: 1, bestLengthCm: 55, bestSpecies: "マルスズキ",
    last: { date: "2026-09-19", ownerName: "ユーキ" } }).join(" ／ ");
  check('単発なら匹数を書かない', !line.includes("匹"), line);
  check('  サイズは書く', line.includes("55cm"), line);
}

/* 実績が無い場所に「0 回」と書かない */
{
  eq('実績が無ければ行ごと出さない',
    app.historyLine({ seasonCaught: 0, bestFish: 0, bestLengthCm: null, last: null }), null);
  eq('history そのものが無くても落ちない', app.historyLine(null), null);
}

/* 潮位置が数えられないときは行を出さない。**0 回と書かない** */
{
  eq('潮位置が分からなければ出さない',
    app.phaseLine({ band: null, samePhase: null }), null);
  eq('同じ潮位置で釣れた回が 0 なら出さない',
    app.phaseLine({ band: "上げ始め", samePhase: 0 }), null);
  eq('null でも落ちない', app.phaseLine(null), null);
}

/* 材料が無くても落ちない */
{
  eq('スポットが無くても落ちない', app.recommendSpots({ today: "2026-09-22" }), []);
  eq('引数が無くても落ちない', app.recommendSpots(), []);
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
