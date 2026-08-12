/**
 * 潮位グラフの平滑化（smoothPath）のテスト。
 *   node frontend/tests/smooth_path.test.mjs
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import { sliceApp } from './_slice.mjs';
// app.js から smoothPath だけ取り出して評価する（範囲は「次の export まで」）
const smoothPath = new Function(sliceApp(['export function smoothPath'])
  + '; return smoothPath;')();

// 3 次ベジェを評価して、実際の曲線が元データの範囲を超えないか調べる
function evalPath(d, steps = 40) {
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const out = [];
  let px = nums[0], py = nums[1];
  out.push({ x: px, y: py });
  for (let i = 2; i + 5 < nums.length + 1; i += 6) {
    const [c1x, c1y, c2x, c2y, x, y] = nums.slice(i, i + 6);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      out.push({
        x: u*u*u*px + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*x,
        y: u*u*u*py + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*y,
      });
    }
    px = x; py = y;
  }
  return out;
}

const results = [];
const check = (n, ok, d='') => results.push([ok, n, d]);

// 実際の潮位データ（舞阪 2026-08-06）
const hourly = [63,61,68,83,100,115,121,118,106,86,61,38,21,13,17,34,59,85,106,118,119,111,95,78];
const pts = hourly.map((v, i) => ({ x: i * 13.33, y: 150 - v }));
const d = smoothPath(pts);

check('C コマンド（3 次ベジェ）を使う', d.includes('C') && !d.includes(' L'), d.slice(0, 60));
check('セグメント数 = 点数 - 1', (d.match(/C/g) || []).length === pts.length - 1);

const curve = evalPath(d);
const ys = curve.map(p => p.y);
const dataMin = Math.min(...pts.map(p => p.y)), dataMax = Math.max(...pts.map(p => p.y));
check('補間がデータ範囲を超えない（オーバーシュートなし）',
  Math.min(...ys) >= dataMin - 1e-6 && Math.max(...ys) <= dataMax + 1e-6,
  `曲線 ${Math.min(...ys).toFixed(2)}〜${Math.max(...ys).toFixed(2)} / データ ${dataMin}〜${dataMax}`);

// 元の各点を必ず通る
const passes = pts.every(p => curve.some(c => Math.abs(c.x - p.x) < 0.01 && Math.abs(c.y - p.y) < 0.01));
check('元データの点をすべて通る', passes);

// 折れ線より滑らか: 隣り合う線分の角度変化の合計で比べる
const totalTurn = (points) => {
  let sum = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = Math.atan2(points[i].y - points[i-1].y, points[i].x - points[i-1].x);
    const b = Math.atan2(points[i+1].y - points[i].y, points[i+1].x - points[i].x);
    let diff = Math.abs(b - a);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    sum += diff;
  }
  return sum;
};
const polyTurn = totalTurn(pts), smoothTurn = Math.max(...curve.map((_, i) => 0)) || 0;
// 曲線は点が多いぶん合計は増えるので、1 点あたりの最大の折れ角で比べる
const maxTurn = (points) => {
  let mx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = Math.atan2(points[i].y - points[i-1].y, points[i].x - points[i-1].x);
    const b = Math.atan2(points[i+1].y - points[i].y, points[i+1].x - points[i].x);
    let diff = Math.abs(b - a);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    mx = Math.max(mx, diff);
  }
  return mx;
};
const polyMax = maxTurn(pts) * 180 / Math.PI, curveMax = maxTurn(curve) * 180 / Math.PI;
check('折れ角が大幅に小さくなる（滑らか）', curveMax < polyMax / 4,
  `折れ線 ${polyMax.toFixed(1)}° → 曲線 ${curveMax.toFixed(1)}°`);

// 単調な区間では単調性が保たれる
const rising = pts.slice(1, 7);   // 61 → 121 と上がり続ける区間
const risingCurve = evalPath(smoothPath(rising));
check('単調増加の区間で上下しない',
  risingCurve.every((p, i) => i === 0 || p.y <= risingCurve[i-1].y + 1e-6));

let ng = 0;
for (const [ok, n, det] of results) { if (!ok) ng++; console.log(`${ok?'PASS':'FAIL'}  ${n}${det?`  [${det}]`:''}`); }
console.log(`\n${results.length-ng}/${results.length} passed`);
process.exit(ng ? 1 : 0);
