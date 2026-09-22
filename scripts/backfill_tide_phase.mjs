/**
 * tide_phase_tenth が空の釣行に、あとから潮位置（上げ7分…）を入れる（D-159）。
 *
 *   1. 対象を JSON に出す（読みだけ）
 *      python3 scripts/supabase_admin.py sql "SELECT json_agg(json_build_object(
 *        'id', r.id, 'date', r.fished_at, 'time', to_char(r.fished_time,'HH24:MI'),
 *        'station', COALESCE(s.tide_area_code, s.tide_station_code),
 *        'area', s.tide_area_code, 'spot', s.name) ORDER BY r.fished_at) AS rows
 *        FROM fishing_records r JOIN spots s ON s.id = r.spot_id
 *        WHERE r.tide_phase_tenth IS NULL AND r.fished_time IS NOT NULL
 *          AND s.tide_station_code IS NOT NULL;"
 *      （rows の中身を scripts/tide_phase_targets.json として置く）
 *   2. node scripts/backfill_tide_phase.mjs   → scripts/tide_phase.sql
 *   3. 中身を見てから apply する
 *
 * **天気の埋め戻し（backfill_weather.mjs）と違って、ブラウザは要らない。**
 * 潮位置の材料は JMA の年間推算値で、tide の Edge Function が過去の日付も
 * そのまま返す。取得上限も無い（同じ観測点・同じ年なら 1 ファイル）。
 *
 * **計算は本番の tidePhaseAt をそのまま使う。** ここで書き直すと、
 * 前後の日のつなぎ方や極値の探し方が本番とずれる。
 * **ずれても画面には出ないので気づけない。**
 *
 * **書き込みはしない。** UPDATE 文を吐くだけ。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { sliceApp } from '../frontend/tests/_slice.mjs';

const run = promisify(execFile);
const SUPABASE_URL = 'https://fglyjgtuzexhccebrctd.supabase.co';

/* 本番の関数をそのまま借りる。
   **地点補正（時差・潮高比）も借りる。** 気賀は 165 分ずれていて、
   ずらさずに数えると潮位置が丸ごと別のところになる。
   fetchTide だけ、下の curl 版に差し替える。 */
const app = new Function(`
  /* **呼ばれた時点で引く。** ここで値を写すと、まだ代入していない
     （このファイルの下のほうで差し替える）undefined を掴む */
  const fetchTide = (...a) => globalThis.__fetchTide(...a);
` + sliceApp([
  // fetchTideForPoint から shiftEvents までは地続き（addDays・interpolate も入る）
  ['export async function fetchTideForPoint(point, date)',
   '/* ---------------- 天気（Open-Meteo・API キー不要） ---------------- */'],
  'export function hoursFromHhmm(hhmm)',
  'export function tidePhaseAt(tide, hhmm',
]) + '; return { tidePhaseAt, fetchTideForPoint };')();

/** 外向きの GET は curl に中継する（この環境はプロキシ越しでしか出られない） */
const cache = new Map();
async function tide(station, date) {
  const key = `${station}|${date}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${SUPABASE_URL}/functions/v1/tide`
    + `?station=${encodeURIComponent(station)}&date=${encodeURIComponent(date)}`;
  let value = null;
  try {
    const { stdout } = await run('curl', ['-sS', '--max-time', '30', url]);
    const body = JSON.parse(stdout);
    value = Array.isArray(body?.hourly_levels_cm) ? body : null;
  } catch { value = null; }
  cache.set(key, value);
  return value;
}

const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const targets = JSON.parse(
  fs.readFileSync(new URL('./tide_phase_targets.json', import.meta.url), 'utf8'));

/* fetchTideForPoint が中で呼ぶ fetchTide を、curl 版に差し替える */
globalThis.__fetchTide = async (station, date) => {
  const body = await tide(station, date);
  if (!body) throw new Error(`潮汐を取得できない: ${station} ${date}`);
  return body;
};

/** 潮位表地点の形を、fetchTideForPoint が期待する形にする */
const pointOf = (t) => ({
  station: t.station,
  area: t.area ?? null,
  lagMinutes: Number(t.lag_minutes ?? 0),
  levelRatio: Number(t.level_ratio ?? 1),
});

const lines = [];
let filled = 0, missing = 0;
for (const t of targets) {
  if (!t.station || !t.time) { missing += 1; continue; }
  const point = pointOf(t);
  const [day, prev, next] = await Promise.all([
    app.fetchTideForPoint(point, t.date).catch(() => null),
    app.fetchTideForPoint(point, addDays(t.date, -1)).catch(() => null),
    app.fetchTideForPoint(point, addDays(t.date, 1)).catch(() => null),
  ]);
  const phase = day ? app.tidePhaseAt(day, t.time, { previous: prev, next }) : null;
  if (!phase) {
    missing += 1;
    console.log(`  - ${t.date} ${t.time} ${t.spot}：出せない`);
    continue;
  }
  filled += 1;
  console.log(`  ${t.date} ${t.time} ${t.spot}`
    + `${point.lagMinutes ? `（${t.area} 時差${point.lagMinutes}分）` : ''} → ${phase.label}`);
  lines.push(`UPDATE public.fishing_records SET tide_phase_tenth = ${phase.tenth}, `
    + `tide_phase_rising = ${phase.rising} WHERE id = '${t.id}' `
    + `AND tide_phase_tenth IS NULL;`);
}

/* **条件なしの UPDATE は書かない。** id で 1 行ずつ、しかも
   まだ空のものだけ（この間に誰かが保存していたら、そちらを残す） */
const sql = ['BEGIN;', ...lines, 'COMMIT;'].join('\n') + '\n';
fs.writeFileSync(new URL('./tide_phase.sql', import.meta.url), sql);
console.log(`\n入れられる ${filled} 件 / 出せない ${missing} 件 → scripts/tide_phase.sql`);
