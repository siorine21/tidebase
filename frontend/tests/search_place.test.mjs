/**
 * 地名検索の応答の読み取り（searchPlace）のテスト。
 *   node frontend/tests/search_place.test.mjs
 *
 * 報告（2026-08-09）: 「アルクスポンド焼津」「庄内湖」が検索できなかった。
 * 原因は、国土地理院の地名検索が**住所の索引**で、管理釣り場のような
 * 施設名や小さな水域名を持っていないこと。OpenStreetMap を足して混ぜる（D-070）。
 *
 * 応答は本物のサンプルの形に合わせてある。ここで押さえたいのは
 *   - 2 つの提供元で JSON の形も緯度経度の並びも違うこと
 *   - 片方が落ちても、もう片方の結果を返すこと
 *   - 探した言葉に近い名前が先に来ること（「焼津市」が先頭に来ない）
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * 対象の関数だけをソースから切り出して評価する。
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const start = src.indexOf('/** 地名検索がつながらなかったときの目印');
const end = src.indexOf('/** 短縮 URL は開かないと座標が入っていない');
const code = src.slice(start, end).replaceAll('export class', 'class').replaceAll('export async function', 'async function')
  // 依存している小さな判定だけ持ち込む
  + `
  function isCoordinateInJapan(lat, lng) {
    const y = Number(lat), x = Number(lng);
    return Number.isFinite(y) && Number.isFinite(x) && y >= 20 && y <= 46 && x >= 122 && x <= 154;
  }
  return { searchPlace, PlaceSearchUnavailable };`;
const { searchPlace, PlaceSearchUnavailable } = new Function(code)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- 本物の応答に合わせたサンプル ---- */
const GSI = (features) => ({ ok: true, json: async () => features });
const OSM = (places) => ({ ok: true, json: async () => places });

const gsiYaizu = [
  // 住所の索引なので、施設名では市までしか当たらない
  { geometry: { coordinates: [138.3230, 34.8666], type: 'Point' }, type: 'Feature',
    properties: { addressCode: '22212', title: '静岡県焼津市' } },
];
const osmYaizu = [
  { place_id: 1, lat: '34.8501', lon: '138.3102', category: 'leisure', type: 'fishing',
    name: 'アルクスポンド焼津', display_name: 'アルクスポンド焼津, 焼津市, 静岡県, 日本' },
];
const osmShonai = [
  { place_id: 2, lat: '34.7364', lon: '137.5789', category: 'natural', type: 'water',
    name: '庄内湖', display_name: '庄内湖, 浜松市, 静岡県, 日本' },
];

/** fetch を差し替える。url に応じて提供元ごとの応答を返す */
function useFetch({ gsi, osm }) {
  globalThis.fetch = async (url) => {
    const isGsi = String(url).includes('msearch.gsi.go.jp');
    const which = isGsi ? gsi : osm;
    if (which === 'down') throw new Error('network');
    if (which === 'error') return { ok: false, status: 503, json: async () => null };
    return isGsi ? GSI(which) : OSM(which);
  };
}

/* ---- 1. 管理釣り場（住所の索引には無い） ---- */
useFetch({ gsi: gsiYaizu, osm: osmYaizu });
{
  const hits = await searchPlace('アルクスポンド焼津');
  check('管理釣り場が見つかる（OSM が拾う）',
    hits.some((h) => h.name === 'アルクスポンド焼津'), JSON.stringify(hits.map((h) => h.name)));
  check('探した名前そのものが先頭に来る（「焼津市」が先に来ない）',
    hits[0]?.name === 'アルクスポンド焼津', JSON.stringify(hits.map((h) => h.name)));
  check('OSM の緯度経度を正しく読む',
    Math.abs(hits[0].lat - 34.8501) < 1e-6 && Math.abs(hits[0].lng - 138.3102) < 1e-6,
    JSON.stringify([hits[0].lat, hits[0].lng]));
  check('住所を説明として出す（同名の場所を見分けるため）',
    hits[0].detail === '焼津市, 静岡県, 日本', hits[0].detail);
  check('住所の索引の結果も残る（消してはいない）',
    hits.some((h) => h.name === '静岡県焼津市'), JSON.stringify(hits.map((h) => h.name)));
}

/* ---- 2. 水域名 ---- */
useFetch({ gsi: [], osm: osmShonai });
{
  const hits = await searchPlace('庄内湖');
  check('湖が見つかる', hits[0]?.name === '庄内湖', JSON.stringify(hits.map((h) => h.name)));
  check('住所側が空でも結果を返す', hits.length === 1, String(hits.length));
}

/* ---- 3. 緯度経度の並び（提供元で違う） ---- */
useFetch({ gsi: [{ geometry: { coordinates: [137.5972, 34.7108] }, properties: { title: '浜名湖' } }], osm: [] });
{
  const [hit] = await searchPlace('浜名湖');
  check('GSI は [経度, 緯度] の順で入っている（入れ替えて読む）',
    Math.abs(hit.lat - 34.7108) < 1e-6 && Math.abs(hit.lng - 137.5972) < 1e-6,
    JSON.stringify([hit.lat, hit.lng]));
}

/* ---- 4. 片方が落ちても止まらない ---- */
useFetch({ gsi: 'down', osm: osmShonai });
check('住所の索引が落ちても OSM の結果を返す',
  (await searchPlace('庄内湖'))[0]?.name === '庄内湖');
useFetch({ gsi: gsiYaizu, osm: 'down' });
check('OSM が落ちても住所の索引の結果を返す',
  (await searchPlace('焼津')).some((h) => h.name === '静岡県焼津市'));
useFetch({ gsi: 'error', osm: 'error' });
{
  let thrown = null;
  await searchPlace('浜名湖').catch((e) => { thrown = e; });
  check('両方だめなときだけ「つながらなかった」にする',
    thrown instanceof PlaceSearchUnavailable, String(thrown));
}

/* ---- 5. 混ぜたときの後始末 ---- */
useFetch({
  gsi: [{ geometry: { coordinates: [137.5972, 34.7108] }, properties: { title: '浜名湖' } }],
  osm: [{ place_id: 3, lat: '34.71085', lon: '137.59725', name: '浜名湖',
          display_name: '浜名湖, 浜松市, 静岡県, 日本' }],
});
check('同じ場所が両方から返ったら 1 つにまとめる',
  (await searchPlace('浜名湖')).filter((h) => h.name === '浜名湖').length === 1,
  JSON.stringify(await searchPlace('浜名湖')));

useFetch({ gsi: [], osm: [
  { place_id: 4, lat: '40.7128', lon: '-74.0060', name: 'New York', display_name: 'New York, USA' },
  { place_id: 5, lat: null, lon: null, name: '壊れた行', display_name: '' },
  { place_id: 6, lat: '34.7108', lon: '137.5972', name: '', display_name: '' },
] });
check('日本の外・座標なし・名前なしは落とす', (await searchPlace('x')).length === 0,
  JSON.stringify(await searchPlace('x')));

useFetch({ gsi: [], osm: Array.from({ length: 10 }, (_, i) => (
  { place_id: i, lat: '34.7', lon: `137.${i}`, name: `候補${i}`, display_name: `候補${i}, 静岡県` })) });
check('候補は 8 件まで', (await searchPlace('候補')).length === 8,
  String((await searchPlace('候補')).length));

check('空の入力では検索しない', (await searchPlace('   ')).length === 0);

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
