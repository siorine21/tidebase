/* TIDEBASE の Service Worker（D-096）。
   ねらいは 1 つ。**圏外の堤防で、今日の潮位と日の出だけは見られるようにする。**

   ここは D-088 / D-089 で片付けた「古い画面が残る」問題と正面からぶつかる。
   Service Worker のキャッシュは HTTP キャッシュと違って**自分で消すまで残る**ので、
   作りを間違えるとあの問題がもっと悪い形で戻ってくる。だから:

     - 画面（HTML）は **必ずネットワークを先に試す**。圏外のときだけ手持ちを出す。
       オンラインで古い画面が出ることは無い。
     - 版付き（?v=<コミット>）の資産だけキャッシュ優先。中身が変われば URL も
       変わるので、古いものを掴み続けることはない。
     - 殻のキャッシュは配信ごとに名前を変え、古いものは activate で捨てる。

   置き場所は frontend の直下。scope を「/tidebase/」全体にするため。 */

const VERSION = "__APP_VERSION__";          // 配信時に GitHub Actions が差し替える
const SHELL_CACHE = `tidebase-shell-${VERSION}`;
const DATA_CACHE = "tidebase-data-v1";      // 配信をまたいで残す（潮汐は版と無関係）

/* 圏外で開いても形になるように、最初に取っておくもの。
   画面はすべて入れる。1 画面 20KB 前後なので、全部でも数百 KB に収まる。

   **版付きの資産は、版付きのまま入れること。** 画面は
   `assets/app.js?v=<コミット>` を読むので、素の URL で入れておいても当たらない
   （キャッシュの鍵は URL そのもの）。ここを間違えると、圏外で画面だけ出て
   中身が動かない、といういちばん困る状態になる。 */
const V = `?v=${VERSION}`;
const SHELL = [
  "./index.html", "./tide.html", "./spots.html", "./spot.html",
  "./records.html", "./record.html", "./record-new.html", "./trends.html",
  "./recipes.html", "./recipe.html", "./recipe-edit.html",
  "./tackle.html", "./settings.html", "./news.html", "./login.html",
  "./plans.html", "./battle.html",
  `./assets/theme.css${V}`, `./assets/app.js${V}`,
  `./assets/icons.js${V}`, `./assets/config.js${V}`,
  "./vendor/supabase.js", "./vendor/fonts/fonts.css",
  "./vendor/leaflet/leaflet.css", "./vendor/leaflet/leaflet.js",
  "./manifest.webmanifest",
  "./assets/icons/app-icon.svg", "./assets/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 1 つでも失敗すると addAll ごと落ちるので、1 件ずつ入れて取りこぼしを許す。
    // フォントなど一部が欠けても、画面が開けることのほうが大事
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) =>
      name.startsWith("tidebase-shell-") && name !== SHELL_CACHE
        ? caches.delete(name) : null));
    await self.clients.claim();
  })());
});

/* ログアウトしたら、その人のデータを端末から消す（画面側から呼ぶ）。 */
self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-data") {
    event.waitUntil?.(caches.delete(DATA_CACHE));
    caches.delete(DATA_CACHE);
  }
});

const isTide = (url) => url.pathname.endsWith("/functions/v1/tide");
const isWeather = (url) => /(^|\.)open-meteo\.com$/.test(url.hostname);
const isRest = (url) => url.pathname.startsWith("/rest/v1/");
// 認証と写真の実体には触らない。トークンや署名付き URL をため込む意味が無い
const isNeverCache = (url) =>
  url.pathname.startsWith("/auth/v1/") || url.pathname.includes("/storage/v1/");

/* キャッシュ優先。**裏での取り直しはしない。**
   ここに来るのは「同じ URL なら中身も同じ」ものだけだから。
     - 版付きの資産 … 中身が変われば URL が変わる（D-088）
     - 潮汐 ………… 日付を決めれば値は決まる
   取り直すと、堤防で電池と通信を無駄に使ううえ、圏外では毎回失敗するだけ。 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;            // 書き込みは素通し
  const url = new URL(request.url);
  if (isNeverCache(url)) return;

  // 画面は必ずネットワーク優先。圏外のときだけ手持ちを出す
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cache = await caches.open(SHELL_CACHE);
        // ?v=… が付いていても、付いていない形で入れてあるものを拾う
        return (await cache.match(request, { ignoreSearch: true }))
          ?? (await cache.match("./index.html"))
          ?? Response.error();
      }
    })());
    return;
  }

  if (isTide(url)) {                                // 潮汐は日付ごとに変わらない
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }
  if (isWeather(url) || isRest(url)) {              // 予報と自分のデータは新しいものを優先
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    // 版付きの資産は中身が変わらないのでキャッシュ優先。それ以外はネットワーク優先
    event.respondWith(url.searchParams.has("v")
      ? cacheFirst(request, SHELL_CACHE)
      : networkFirst(request, SHELL_CACHE));
  }
});
