/**
 * weather_snapshot が空の釣行に、あとから天気を入れる（D-153）。
 *
 *   1. 対象を JSON に出す（読みだけ）
 *      python3 scripts/supabase_admin.py sql "SELECT json_agg(json_build_object(
 *        'id', r.id, 'date', r.fished_at, 'time', to_char(r.fished_time,'HH24:MI'),
 *        'lat', s.latitude::float8, 'lng', s.longitude::float8, 'spot', s.name)
 *        ORDER BY r.fished_at) AS rows
 *        FROM fishing_records r JOIN spots s ON s.id = r.spot_id
 *        WHERE r.weather_snapshot IS NULL;" > raw.json
 *      （rows の中身を targets.json として、このファイルの隣に置く）
 *   2. frontend/ を 127.0.0.1:8099 で配る（python3 -m http.server）
 *   3. node scripts/backfill_weather.mjs   → snapshots.json
 *   4. python3 scripts/backfill_weather_sql.py → backfill.sql
 *   5. 中身を見てから apply する
 *
 * **値づくりは実アプリの captureWeatherSnapshot にやらせる。**
 * ここで組み立て直すと、区間の値の取り方（1 つ後ろ・D-111）や
 * マヅメの判定が本番とずれる。**ずれても画面には出ないので気づけない。**
 *
 * 通信はこのスクリプトの curl に中継する（ブラウザからは外へ出さない）。
 * **書き込みはしない。** 作った値を JSON に吐くだけ。
 *
 * Open-Meteo の無料枠には 1 日の上限がある。使い切ると 429 が返るので、
 * 残りは翌日にもう一度回す（同じ入力なら同じところから続く）。
 */
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const run = promisify(execFile);
const BASE = 'http://127.0.0.1:8099';
const targets = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));

/** 外向きの GET は curl に中継する（この環境はプロキシ越しでしか出られない） */
/* **先に全部ためてから、キャッシュだけで走らせる。**
   ブラウザ側の fetch には 15 秒の打ち切りがあり（D-140 の FETCH_TIMEOUT_MS）、
   curl の再試行を待っていると先に諦められる。しかも失敗の出方が毎回違うので、
   同じ入力で同じ結果にならない。**取りこぼしを回数で誤魔化さない。** */
import crypto from 'node:crypto';
const CACHE = new URL('./cache/', import.meta.url);
fs.mkdirSync(CACHE, { recursive: true });
const cachePath = (url) =>
  new URL(`${crypto.createHash('sha1').update(url).digest('hex')}.json`, CACHE);

const wanted = new Set();          // まだ手元に無い URL
const gaveUp = new Set();          // 何度やっても埋まらなかった URL

/** 応答が「200 だが中身が空」か。上限超過のときにこの形で返ってくる。
    **波（marine）には使わない。** 内陸の池や川では「波は無い」が正しい答えで、
    それを失敗とみなすと永久に取り直し続ける（実際そうなって止まった） */
function isEmptyBody(text) {
  let body;
  try { body = JSON.parse(text); } catch { return true; }
  if (body.error) return true;
  const h = body.hourly;
  if (!h?.time?.length) return true;
  return !Object.entries(h).some(([k, v]) =>
    k !== 'time' && Array.isArray(v) && v.some((x) => x != null));
}
function cached(url) {
  const f = cachePath(url);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

/** 手元に無い URL を、落ち着いて何度でも取りに行く */
async function fillCache() {
  let got = 0;
  for (const url of [...wanted]) {
    if (cached(url)) { wanted.delete(url); continue; }
    if (gaveUp.has(url)) { wanted.delete(url); continue; }
    for (let i = 0; i < 4; i++) {
      try {
        const { stdout } = await run('curl', ['-sS', '--max-time', '90', url],
          { maxBuffer: 32 * 1024 * 1024 });
        /* **空の応答は覚えない**（D-140 と同じ）。Open-Meteo は 1 日の上限を
           超えると 200 のまま全部 null を返すことがある。それを溜めると、
           「取れなかった」ではなく「無風・無降水だった」として残ってしまう */
        const mustHaveValues = !url.includes('marine-api');
        if (stdout && stdout.trim().startsWith('{')
            && !(mustHaveValues && isEmptyBody(stdout))) {
          fs.writeFileSync(cachePath(url), stdout);
          wanted.delete(url); got++;
          break;
        }
      } catch { /* 通信の失敗は待って繰り返す */ }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    if (!cached(url)) {
      /* **諦めたことを覚える。** 覚えないと毎周おなじ URL で同じ待ちを繰り返し、
         いつまでも終わらない（内陸スポットの波でそうなった） */
      gaveUp.add(url); wanted.delete(url);
      console.log(`   [諦めた] ${url.slice(0, 78)}`);
    }
  }
  return got;
}

const PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head><body>
<script src="/vendor/supabase.js"></script>
<script src="/assets/config.js"></script>
<script type="module">
  import { captureWeatherSnapshot } from "/assets/app.js";
  window.__capture = captureWeatherSnapshot;
  window.__ready = true;
</script>
</body></html>`;

/* **ブラウザの裏の通信を全部止める。** 止めないと Chromium が
   google.com / accounts.google.com を叩き続け、中継のトンネルが詰まって
   こちらの curl まで SSL_ERROR_SYSCALL で落ちるようになる（実際に詰まった） */
const LAUNCH = {
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-background-networking', '--disable-component-update',
         '--disable-sync', '--no-first-run', '--disable-default-apps',
         '--safebrowsing-disable-auto-update', '--disable-domain-reliability',
         '--metrics-recording-only', '--no-default-browser-check'],
};

async function openBrowser() {
  const browser = await chromium.launch(LAUNCH);
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await route(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [page error]', e.message));
  return { browser, page };
}

async function route(ctx) {
await ctx.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.endsWith('/_backfill.html')) {
    return route.fulfill({ body: PAGE, contentType: 'text/html; charset=utf-8' });
  }
  if (url.startsWith(BASE)) return route.continue();
  if (url.includes('open-meteo.com')) {
    const body = cached(url);
    if (body === null) {
      /* **待たない。** 欲しい URL を控えて、すぐ諦める。
         このあとまとめて取りに行き、もう一周する */
      wanted.add(url);
      return route.fulfill({ status: 599, body: '{}', contentType: 'application/json' });
    }
    return route.fulfill({ body, contentType: 'application/json' });
  }
  /* **ほかは 1 本も外に出さない。** Supabase にも触らない */
  return route.fulfill({ status: 403, body: '{}', contentType: 'application/json' });
});
}

let out = [];
for (let round = 1; round <= 8; round++) {
  /* **ブラウザは毎回立て直す。** fetchWeather は取れた予報を覚えるので（D-140）、
     空を掴んだまま次の周回に持ち越してしまう。
     **curl の最中はブラウザを閉じておく**（同時に動かすと中継が詰まる） */
  const { browser, page } = await openBrowser();
  await page.goto(`${BASE}/_backfill.html`);
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });

  out = [];
  for (const t of targets) {
    const snap = await page.evaluate(async (row) => {
      try {
        return await window.__capture({ lat: row.lat, lng: row.lng, date: row.date, time: row.time });
      } catch (e) { return { __error: String(e?.message ?? e) }; }
    }, t);
    out.push({ ...t, snapshot: snap?.__error ? null : snap });
  }
  await browser.close();                // ここから先は curl だけ
  const got = out.filter((r) => r.snapshot?.weather_code != null).length;
  console.log(`${round} 周目: ${got} / ${out.length} 件（未取得の URL ${wanted.size} 本）`);
  if (got === out.length) break;
  if (!wanted.size) break;              // 取りに行く先が無いなら、これ以上は変わらない
  const filled = await fillCache();
  console.log(`   ${filled} 本ためた（残り ${wanted.size} 本）`);
  if (!filled) break;
}

for (const r of out) {
  const s2 = r.snapshot;
  console.log(`${r.date} ${r.time} ${r.spot.padEnd(16)} `
    + (s2 ? `${s2.source} / 記号 ${s2.weather_code} / ${s2.temp_c}℃ / 風 ${s2.wind_speed_ms} / ${s2.band}`
          : '取れなかった'));
}

fs.writeFileSync(new URL('./snapshots.json', import.meta.url),
  JSON.stringify(out, null, 1));
const ok = out.filter((r) => r.snapshot && r.snapshot.weather_code != null).length;
console.log(`\n作れた: ${ok} / ${out.length}`);
