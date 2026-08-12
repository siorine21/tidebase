/**
 * 貼り付けられた座標・地図 URL の読み取り（parseLatLng）のテスト。
 *   node frontend/tests/parse_latlng.test.mjs
 *
 * ここは地名検索が使えないときの最後の逃げ道なので（D-069）、
 * 読み取りを間違えると「探せないし貼れもしない」になる。
 * とくに緯度経度の順番の取り違えは、地図が地球の裏側へ飛ぶだけで
 * エラーにならないため、テストで押さえておく。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([['const SHORT_MAP_LINK', 'export function attachSpotPicker']]);
const { parseLatLng, isShortMapLink } =
  new Function(code + '; return { parseLatLng, isShortMapLink };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const near = (a, b) => a != null && Math.abs(a - b) < 1e-6;
const at = (name, text, lat, lng) => {
  const got = parseLatLng(text);
  check(name, got != null && near(got.lat, lat) && near(got.lng, lng), JSON.stringify(got));
};
const none = (name, text) => check(name, parseLatLng(text) === null, JSON.stringify(parseLatLng(text)));

/* ---- 素の座標 ---- */
at('カンマ区切りの座標', '34.7108, 137.5972', 34.7108, 137.5972);
at('空白区切りの座標', '34.7108 137.5972', 34.7108, 137.5972);
at('前後に空白があっても読む', '  34.7108,137.5972  ', 34.7108, 137.5972);
at('負の値（南半球・西経）も読む', '-33.8688, 151.2093', -33.8688, 151.2093);
at('整数だけでも読む', '35, 139', 35, 139);

/* ---- Google マップ ---- */
at('place URL は !3d!4d（地点そのもの）を採る',
  'https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E9%A7%85/@35.6800000,139.7600000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d35.6812362!4d139.7671248',
  35.6812362, 139.7671248);
at('@ しかない URL は画面中心を採る',
  'https://www.google.com/maps/@34.7108000,137.5972000,15z', 34.7108, 137.5972);
at('?q=緯度,経度', 'https://maps.google.com/?q=34.7108,137.5972', 34.7108, 137.5972);
at('?ll=緯度,経度（Apple マップ）',
  'https://maps.apple.com/?ll=34.7108,137.5972&q=%E6%B5%9C%E5%90%8D%E6%B9%96', 34.7108, 137.5972);
at('geo: URI', 'geo:34.7108,137.5972', 34.7108, 137.5972);

/* ---- 緯度経度の順番（ここを間違えると地球の裏側へ飛ぶ） ---- */
{
  const got = parseLatLng('https://www.google.com/maps/@34.7108,137.5972,15z');
  check('緯度が先・経度が後（入れ替わっていない）',
    near(got?.lat, 34.7108) && near(got?.lng, 137.5972), JSON.stringify(got));
}

/* ---- 読まないもの ---- */
none('地名は座標として読まない', '浜名湖');
none('住所も座標として読まない', '静岡県浜松市中央区舘山寺町');
none('空文字', '');
none('数字ひとつだけ', '34.7108');
none('緯度が 90 を超える', '95.0, 137.5');
none('経度が 180 を超える', '34.7, 200.0');
none('座標を含まない URL', 'https://example.com/page?id=12345');
check('null や undefined でも落ちない',
  parseLatLng(null) === null && parseLatLng(undefined) === null);

/* ---- 短縮 URL は座標が入っていないので、別に気づかせる ---- */
check('短縮 URL を見分ける', isShortMapLink('https://maps.app.goo.gl/abcdEFGH1234'));
check('旧 goo.gl/maps も見分ける', isShortMapLink('https://goo.gl/maps/abcdEFGH1234'));
check('短縮 URL は座標としては読まない',
  parseLatLng('https://maps.app.goo.gl/abcdEFGH1234') === null);
check('普通の URL は短縮 URL 扱いしない',
  !isShortMapLink('https://www.google.com/maps/@34.7108,137.5972,15z'));

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
