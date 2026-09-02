/**
 * 同じものを 2 度取らない仕組み（D-140）のテスト。
 *   node frontend/tests/request_cache.test.mjs
 *
 * ホームは毎回、同じ潮汐（08-26 と 08-27）を 2 回ずつ取っていた。
 * 時差のある地点では fetchTideForPoint が前後の日もつなぐので、
 * 3 日ぶん描くと日付が重なる。**取る側では気づけない**（それぞれは正しい）。
 *
 * ここで押さえるのは 4 つ。
 *   - 同じ観測所・同じ日付は 1 回しか取りに行かない
 *   - **約束のまま覚える**。結果が返ってから覚えると、ほぼ同時に投げた
 *     2 本目が「まだ無い」を見て走り出す
 *   - 失敗したものは覚えない（一度の不通が画面を開いているあいだ残る）
 *   - 前回の地点を照合する鍵が、保存する側と読む側で同じ
 */
import { sliceApp } from './_slice.mjs';

/* fetchTide はブラウザの fetch と config を使う。どちらもここで差し替える。
   **呼ばれた回数を数えたい**ので、本物の通信はしない。 */
const prelude = `
  const calls = [];
  const config = { supabaseUrl: "https://example.test" };
  let nextFails = false;
  function fetchWithTimeout(url) {
    calls.push(url);
    if (nextFails) return Promise.reject(new Error("つながらない"));
    // すぐには返さない。同時に投げた 2 本目が走り出さないかを見たいので
    return new Promise((resolve) => setTimeout(() =>
      resolve({ ok: true, json: async () => ({ url }) }), 10));
  }
`;
const code = sliceApp([
  ['/* 取りに行った潮汐を、この画面が開いているあいだ覚えておく（D-140）。',
   '/* ---------------- 月齢・潮回り（D-062） ----------------'],
  ['/* 前回どこを見ていたかを、地点まで含めて覚えておく（D-140）。',
   'export function pickBaseSpot'],
  // 波も同じ形で 1 本にまとめる（D-144）。カメラの波は marine の 1 本だけで取る
  ['/* ライブ映像に添える波（D-144）。**波だけを取りに行く。**',
   'async function fetchWeatherUncached'],
], prelude);

/* localStorage はブラウザのもの。覚える・読むだけなので、ここで作る */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const app = new Function(code
  + `; return { fetchTide, fetchWaves, rememberedView, rememberView, sameView,
      _calls: () => calls, _fail: (v) => { nextFails = v; } };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 同じものを 2 度取らない ---- */

{
  const before = app._calls().length;
  await app.fetchTide('MI', '2026-08-26');
  await app.fetchTide('MI', '2026-08-26');
  await app.fetchTide('MI', '2026-08-26');
  check('同じ観測所・同じ日付は 1 回だけ取りに行く',
    app._calls().length - before === 1, `${app._calls().length - before} 回`);
}
{
  const before = app._calls().length;
  await app.fetchTide('MI', '2026-08-27');
  await app.fetchTide('OM', '2026-08-26');
  check('観測所か日付が違えば取りに行く',
    app._calls().length - before === 2, `${app._calls().length - before} 回`);
}

/* **ここが肝**。結果が返ってから覚える作りだと、ほぼ同時に投げた 2 本目が
   「まだ無い」を見て走り出す。ホームは実際にこの形で重ねていた。
   罠: 覚えるのを await のあとに移すと、ここで落ちる。 */
{
  const before = app._calls().length;
  await Promise.all([
    app.fetchTide('SM', '2026-08-26'),
    app.fetchTide('SM', '2026-08-26'),
    app.fetchTide('SM', '2026-08-26'),
  ]);
  check('同時に投げても 1 回だけ（約束のまま覚える）',
    app._calls().length - before === 1, `${app._calls().length - before} 回`);
}

/* ---- 失敗は覚えない ---- */
{
  app._fail(true);
  await app.fetchTide('Z5', '2026-08-26').catch(() => {});
  app._fail(false);
  const before = app._calls().length;
  /* **投げ直しても落ちないこと**まで見る。覚えたままだと、次の呼び出しが
     覚えてある「失敗した約束」を返すので、ここで例外になる。
     try で受けないとテストごと落ちて、FAIL の行が出ないまま終わる。 */
  let got = null, threw = null;
  try { got = await app.fetchTide('Z5', '2026-08-26'); } catch (e) { threw = e; }
  check('失敗したものは覚えない（次はちゃんと取りに行く）',
    threw === null && got != null && app._calls().length - before === 1,
    threw ? `覚えたままだった: ${threw.message}` : `${app._calls().length - before} 回`);
}

/* ---- 前回の地点の鍵 ---- */

/* **保存する側と読む側で鍵が同じか。** ここを取り違えて、
   まだスポットを選んでいない人（savedBaseSpot() が null）のとき
   毎回外れる形になっていた。実測で「先行投げ なし」が続いて気づいた。 */
{
  const point = { value: 'ST:MI', station: 'MI', lagMinutes: 0, levelRatio: 1 };
  const at = { lat: 34.68, lng: 137.6 };
  app.rememberView(null, point, at);
  const back = app.rememberedView(null);
  check('まだ選んでいない人（鍵が null）でも照合できる', back != null);
  check('覚えた地点がそのまま返る',
    app.sameView(back?.point, point) && app.sameView(back?.weatherAt, at));
}
{
  const point = { value: 'ST:OM', station: 'OM', lagMinutes: 0, levelRatio: 1 };
  app.rememberView('spot-a', point, { lat: 1, lng: 2 });
  check('別のスポットを選んでいたら使わない', app.rememberedView('spot-b') === null);
  check('同じスポットなら使う', app.rememberedView('spot-a') != null);
}
{
  const a = { value: 'ST:MI', lagMinutes: 0 };
  check('地点が違えば「同じ」と言わない',
    app.sameView(a, { value: 'ST:OM', lagMinutes: 0 }) === false);
  check('中身が同じなら「同じ」と言う', app.sameView(a, { value: 'ST:MI', lagMinutes: 0 }));
  check('どちらも無ければ「同じ」', app.sameView(null, null) && app.sameView(undefined, null));
}
{
  store.set('tidebase.lastView', '{壊れた');
  check('覚えたものが壊れていても落ちない', app.rememberedView(null) === null);
}

/* ---- カメラの波も 1 本にまとめる（D-144） ----
   ライブカメラの波は**選んでいるスポットとは別の座標**で取る。
   ホームで潮と天気を描き直すたびに呼ばれても、通信は 1 回で済むこと。 */
{
  const before = app._calls().length;
  const [a, b] = await Promise.all([
    app.fetchWaves(34.63, 137.93, '2026-09-03'),
    app.fetchWaves(34.63, 137.93, '2026-09-03'),
  ]);
  check('同じ座標・同じ日は 1 回しか取りに行かない',
    app._calls().length - before === 1, `${app._calls().length - before} 回`);
  check('2 本目にも同じものが返る', a === b);
}
{
  const before = app._calls().length;
  await app.fetchWaves(34.63, 137.93, '2026-09-04');
  check('日が違えば取りに行く', app._calls().length - before === 1);
}
{
  const before = app._calls().length;
  await app.fetchWaves(34.72, 137.60, '2026-09-03');
  check('座標が違えば取りに行く', app._calls().length - before === 1);
}
/* **marine だけを叩く。** 気温も雨も要らないので、予報のほうは呼ばない。
   罠: fetchWeather をそのまま使うと 2 本になり、ここで落ちる */
check('波は marine の 1 本だけで取る',
  app._calls().slice(-1)[0].startsWith('https://marine-api.open-meteo.com/'),
  app._calls().slice(-1)[0]);
check('その日ぶんだけ頼む（翌日を混ぜない）',
  app._calls().slice(-1)[0].includes('start_date=2026-09-03&end_date=2026-09-03'),
  app._calls().slice(-1)[0]);
/* **失敗は覚えない**（D-140）。一度の不通が画面を開いているあいだ残ると、
   電波が戻っても波が二度と出ない */
{
  app._fail(true);
  let threw = false;
  try { await app.fetchWaves(35.0, 139.0, '2026-09-03'); } catch { threw = true; }
  check('つながらなければそのまま失敗を返す', threw);
  app._fail(false);
  const before = app._calls().length;
  /* **必ず受け止める。** 覚えていた失敗をそのまま返してくると、ここで例外が飛び、
     FAIL を出す前に script ごと落ちる。**落ちると罠を仕掛けても気づけない。**
     同じことを 1 度やっている（D-140 のときの 2 つ目の罠） */
  let again = null;
  try { await app.fetchWaves(35.0, 139.0, '2026-09-03'); } catch (e) { again = e; }
  check('**失敗したものは覚えない**（次にもう一度取りに行く）',
    again === null && app._calls().length - before === 1,
    again ? `覚えた失敗が返ってきた: ${again.message}` : `${app._calls().length - before} 回`);
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
