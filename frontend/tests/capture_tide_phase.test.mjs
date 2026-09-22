/**
 * 記録するときに潮位置（上げ7分…）を残す処理（D-159）のテスト。
 *   node frontend/tests/capture_tide_phase.test.mjs
 *
 * **ここは「片方だけ」と「勝手に消す」を止めるところ。**
 * 潮位置は向きと N 分が対で初めて意味を持つ。片方だけ返すと、
 * 数える側が「向きの無い 7 分」を黙って混ぜてしまう。
 *
 * もう 1 つは取れなかったときの振る舞い。**取れないことと、
 * 潮が効かないことは別**で、どちらも「入れない」で正しいが、
 * ここで例外を投げると**記録そのものが保存できなくなる**（D-096）。
 *
 * 押さえるのは 4 つ。
 *   - 取れたら tenth と rising を**対で**返す
 *   - 材料が無い（時刻なし・潮汐地点なし）なら null。**投げない**
 *   - 通信が失敗しても null。記録の保存は止めない
 *   - 前後の日も取りに行く（満干の区間は 6 時間あり、日をまたぐ）
 */
import { sliceApp } from './_slice.mjs';

/* app.js の外にあるものを差し替える。**何を取りに行ったか**を見たい */
const prelude = `
  let fetched = [];
  let failDates = new Set();
  let points = [{ value: "ST:MI", station: "MI", area: null, lagMinutes: 0, levelRatio: 1 }];

  async function listTidePoints() { return points; }
  function spotTidePoint(spot, list) {
    const value = spot?.tide_area_code ? "AR:" + spot.tide_area_code
      : spot?.tide_station_code ? "ST:" + spot.tide_station_code : null;
    return value ? ((list ?? []).find((p) => p.value === value) ?? null) : null;
  }
  function addDays(date, days) {
    return new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  }
  /* 08:00 が満潮、14:00 が干潮に近い形。上げ下げの両方が出る */
  const LEVELS = [60,45,32,25,28,40,62,88,110,118,112,96,74,52,34,26,30,48,72,96,114,120,110,88];
  async function fetchTideForPoint(point, date) {
    fetched.push(date);
    if (failDates.has(date)) throw new Error("取れない");
    return { station: point.station, date, hourly_levels_cm: LEVELS, point };
  }
`;

const code = sliceApp([
  ['export function tidePhaseAt(tide, hhmm', '/**\n * 1 時間ぶんの点'],
  ['export async function captureTidePhase', '/**\n * 天気がどこから来たかの一言'],
  'function interpolate(series, index)',
  'export function hoursFromHhmm(hhmm)',
], prelude);

const app = new Function(code + `; return { captureTidePhase, tidePhaseAt,
  _fetched: () => fetched,
  _reset: () => { fetched = []; failDates = new Set(); },
  _failOn: (...d) => { failDates = new Set(d); },
  _noPoints: () => { points = []; },
  _restorePoints: () => {
    points = [{ value: "ST:MI", station: "MI", area: null, lagMinutes: 0, levelRatio: 1 }];
  } };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const SPOT = { id: "s1", tide_station_code: "MI", tide_area_code: null };
const AT = { date: "2026-09-22", time: "10:30" };

/* ---- 取れたら対で返る ---- */
{
  app._reset();
  const got = await app.captureTidePhase(SPOT, AT);
  check('tenth と rising が対で返る',
    got != null && typeof got.tenth === 'number' && typeof got.rising === 'boolean',
    JSON.stringify(got));
  check('**片方だけにならない**',
    got == null || (got.tenth != null && got.rising != null), JSON.stringify(got));
  check('tenth は 0〜10', got == null || (got.tenth >= 0 && got.tenth <= 10), String(got?.tenth));
  /* 10:30 は 08:00 の満潮を過ぎて下がっている途中 */
  eq('下げになる', got?.rising, false);
  /* **label は返さない。** DB の列は tenth と rising の 2 つで、
     文言は読む側が作る。ここで文字列を混ぜると保存できない形になる */
  eq('DB の列だけを返す', Object.keys(got ?? {}).sort(), ['rising', 'tenth']);
}

/* ---- 前後の日も取りに行く ----
   満干の区間は 6 時間あり、日をまたぐ。当日だけだと端の時刻で出せない */
{
  app._reset();
  await app.captureTidePhase(SPOT, AT);
  const days = app._fetched().slice().sort();
  eq('**前日・当日・翌日の 3 日を取る**', days,
    ['2026-09-21', '2026-09-22', '2026-09-23']);
}

/* ---- 材料が無ければ null。投げない ---- */
for (const [name, spot, at] of [
  ['時刻が無ければ null', SPOT, { date: "2026-09-22", time: null }],
  ['日付が無ければ null', SPOT, { date: null, time: "10:30" }],
  ['スポットが無ければ null', null, AT],
  ['引数そのものが無ければ null', SPOT, undefined],
]) {
  app._reset();
  let threw = null;
  const got = await app.captureTidePhase(spot, at).catch((e) => { threw = e; return 'THREW'; });
  eq(name, got, null);
  check(`  ${name}（投げない）`, threw === null, String(threw?.message ?? ''));
  eq(`  ${name}（取りに行かない）`, app._fetched().length, 0);
}

/* 潮汐地点を持たないスポット（管理釣り場・淡水の池）。**取りに行かない** */
{
  app._reset();
  const got = await app.captureTidePhase(
    { id: "s2", tide_station_code: null, tide_area_code: null }, AT);
  eq('潮汐の効かない場所は null', got, null);
  eq('  そもそも取りに行かない', app._fetched().length, 0);
}

/* ---- 通信が失敗しても、記録の保存は止めない ---- */
{
  app._reset();
  app._failOn('2026-09-22');
  let threw = null;
  const got = await app.captureTidePhase(SPOT, AT).catch((e) => { threw = e; return 'THREW'; });
  eq('当日が取れなければ null', got, null);
  check('**投げない**（記録は保存できる）', threw === null, String(threw?.message ?? ''));
}
{
  app._reset();
  app._failOn('2026-09-21', '2026-09-23');
  let threw = null;
  const got = await app.captureTidePhase(SPOT, AT).catch((e) => { threw = e; return 'THREW'; });
  check('前後が取れなくても投げない', threw === null, String(threw?.message ?? ''));
  check('  真ん中の時刻なら出せる', got != null, JSON.stringify(got));
}

/* 潮位表地点の一覧が取れないとき（圏外）。ここでも投げない */
{
  app._reset();
  app._noPoints();
  let threw = null;
  const got = await app.captureTidePhase(SPOT, AT).catch((e) => { threw = e; return 'THREW'; });
  eq('地点が引けなければ null', got, null);
  check('  投げない', threw === null, String(threw?.message ?? ''));
  app._restorePoints();
}

/* ---- 渡された地点をそのまま使う（毎回引き直さない） ---- */
{
  app._reset();
  const got = await app.captureTidePhase(SPOT, { ...AT,
    points: [{ value: "ST:MI", station: "MI", area: null, lagMinutes: 0, levelRatio: 1 }] });
  check('points を渡せば、それで引ける', got != null, JSON.stringify(got));
}

/* ---- 頂点ちょうどは出さない ----
   向きが決まらない時刻。**「分からない」を「0 分」と言い換えない** */
{
  app._reset();
  // 08:00 がこの形の満潮（118 の前後が 110 / 112 でほぼ平ら）
  const got = await app.captureTidePhase(SPOT, { date: "2026-09-22", time: "09:00" });
  check('頂点付近でも、出すなら対で出す',
    got == null || (got.tenth != null && got.rising != null), JSON.stringify(got));
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
