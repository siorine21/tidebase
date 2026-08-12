/**
 * スポット種別の色のテスト（D-110）。
 *   node frontend/tests/spot_colors.test.mjs
 *
 * 色は**地図のピンと凡例で種別を見分ける唯一の手がかり**（形は立ち位置に譲った・D-101）。
 * もとは 4 組が同じ色で、凡例には別々に並んでいるのに地図では見分けられなかった
 * （磯 = 管理釣り場、サーフ = 汽水湖、水路・運河 = 河川、テトラ帯 = 未設定）。
 * **目で見て気づけない類いの壊れ方**なので、機械で押さえる。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の定義だけをソースから切り出して評価する。
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
  slice('export const SPOT_TYPES = [', '/* 立ち位置（D-099'),
  slice('export function spotType(value)', '\n/* 種別の並び'),
].join('\n').replaceAll('export ', '');
const { SPOT_TYPES, spotType } =
  new Function(code + '; return { SPOT_TYPES, spotType };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 色の計算（sRGB → CIE Lab、相対輝度） ---- */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function luminance(hex) {
  const [r, g, b] = channels(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function lab(hex) {
  const [r, g, b] = channels(hex).map(toLinear);
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X / 0.95047), f(Y / 1), f(Z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

/* 見る場所は 2 つ。**どちらでも読めないと意味がない。**
   - ピンは色が地で、中の線が暗い（theme.css: .spot-pin .icon）
   - 凡例・一覧の丸は、暗い背景の上に置く */
const PIN_GLYPH = '#0A1520';
const APP_BG = '#0F1E2E';
const MIN_DELTA_E = 22;     // これ未満は隣に並べると同じ色に見える
const MIN_CONTRAST = 3.5;

// 未設定も画面では 1 つの種別として並ぶので、同じ土俵で見る
const ALL = [...SPOT_TYPES, { ...spotType(null), value: '(未設定)' }];

check('種別と未設定で 13 色ある', ALL.length === 13, String(ALL.length));
check('色の書き方が揃っている（#RRGGBB）',
  ALL.every((t) => /^#[0-9A-F]{6}$/.test(t.color)),
  ALL.filter((t) => !/^#[0-9A-F]{6}$/.test(t.color)).map((t) => t.color).join(' ') || 'すべて OK');

/* ---- 同じ色が無いこと ---- */
const byColor = new Map();
for (const t of ALL) {
  const key = t.color.toUpperCase();
  byColor.set(key, [...(byColor.get(key) ?? []), t.label]);
}
const same = [...byColor.entries()].filter(([, ls]) => ls.length > 1);
check('**同じ色の種別が無い**', same.length === 0,
  same.map(([c, ls]) => `${c} = ${ls.join(' / ')}`).join(', ') || '重複なし');

/* ---- 隣に並べて別の色に見えること ---- */
const pairs = [];
for (let i = 0; i < ALL.length; i++) {
  for (let j = i + 1; j < ALL.length; j++) {
    pairs.push({ d: deltaE(ALL[i].color, ALL[j].color), a: ALL[i], b: ALL[j] });
  }
}
pairs.sort((x, y) => x.d - y.d);
const tooClose = pairs.filter((p) => p.d < MIN_DELTA_E);
check(`どの 2 色も ΔE ${MIN_DELTA_E} 以上`, tooClose.length === 0,
  tooClose.length
    ? tooClose.map((p) => `${p.a.label}↔${p.b.label} ΔE ${p.d.toFixed(1)}`).join(', ')
    : `いちばん近い組は ${pairs[0].a.label}↔${pairs[0].b.label} の ΔE ${pairs[0].d.toFixed(1)}`);

/* ---- どちらの場所でも読めること ---- */
const dimGlyph = ALL.filter((t) => contrast(t.color, PIN_GLYPH) < MIN_CONTRAST);
check('ピンの中の線が読める（色が暗すぎない）', dimGlyph.length === 0,
  dimGlyph.map((t) => `${t.label} ${contrast(t.color, PIN_GLYPH).toFixed(1)}:1`).join(', ') || 'すべて OK');

const dimBg = ALL.filter((t) => contrast(t.color, APP_BG) < MIN_CONTRAST);
check('暗い背景の上で凡例の丸が見える', dimBg.length === 0,
  dimBg.map((t) => `${t.label} ${contrast(t.color, APP_BG).toFixed(1)}:1`).join(', ') || 'すべて OK');

/* ---- 画面の他の色と揃えてある 3 つは動かさない ---- */
const theme = fs.readFileSync(new URL('../assets/theme.css', import.meta.url), 'utf8');
const token = (name) => theme.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase();
for (const [value, name] of [['surf', 'blue'], ['rock', 'green'], ['port', 'mustard']]) {
  const t = SPOT_TYPES.find((x) => x.value === value);
  check(`${t.label} は theme.css の --${name} と同じ`,
    t.color.toUpperCase() === token(name), `${t.color} / ${token(name)}`);
}

/* ---- 種別が増えたときに気づけるように ---- */
check('アイコン名がすべて入っている', SPOT_TYPES.every((t) => t.iconName),
  SPOT_TYPES.filter((t) => !t.iconName).map((t) => t.label).join(' ') || 'すべて OK');

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
