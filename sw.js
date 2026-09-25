// ★オフラインでも起動できるようにするための Service Worker（GitHub Pages版だけ）。
//
// なぜ要るか。ホーム画面アプリなのに**圏外・地下鉄・機内モードでは起動できなかった**。
// 毎日使う学習アプリでこれがいちばん痛い穴だった（2026/9/18に追加）。
//
// ⚠⚠ **「古い版が配信され続ける」事故を悪化させないことが最優先である。**
//   2026/9/9、Pagesのデプロイ失敗で1つ前の版がiPhoneに配信され続けた。
//   Service Worker はキャッシュを持つので、設計を誤ると同じ事故が
//   「デプロイは成功しているのに古い版が出る」形で再発する。そのため：
//
//   ① **`version.txt` は絶対にキャッシュしない。** ここをキャッシュすると
//      `checkForUpdate()` の更新検知そのものが死ぬ。fetch ハンドラで触らず、
//      ブラウザ既定のネットワーク処理に任せる（アプリ側は `cache: 'no-store'`）。
//   ② **本体（ナビゲーション）はネットワーク優先＋毎回サーバに再検証**にする。
//      キャッシュ優先の方が起動は速いが、古い版が残るリスクが上がる。
//      **速度より正しさを取る**。中身が変わっていなければ 304 なので、
//      5.3MBを取り直すわけではない。オフラインのときだけキャッシュに落ちる。
//   ③ キャッシュ名に**版（BUILD_STAMP）を入れる**ので、新しい版が入った時点で
//      古いキャッシュは activate で消える。取り残りが起きない。
//
// ⚠ `sw.js` 自身がHTTPキャッシュに残ると更新が遅れるので、
//   登録側で `updateViaCache: 'none'` を付けている（app.js の registerServiceWorker）。
const VERSION = '2026-09-25 18:38';
const CACHE = 'sekaiisan-' + VERSION;

// './' は配信先のディレクトリ（＝index.html）。PDF.js はページを送るのに要る。
// ⚠ PDFの本体は利用者の端末（IndexedDB／ファイル参照）にあるので、ここには入れない。
const PRECACHE = ['./', './pdf.min.mjs', './pdf.worker.min.mjs'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // ⚠ `cache.addAll()` は1つでも失敗すると install 全体が失敗する。
    //   PDF.js が置かれていない配信先でもオフライン化だけは成立させたいので個別に扱う。
    // ⚠ `cache: 'reload'` を付ける——付けないとHTTPキャッシュの古い写しを
    //   そのまま取り込んでしまい、「新しい版なのに中身が古い」ことが起きる。
    await Promise.allSettled(PRECACHE.map(async u => {
      const res = await fetch(u, { cache: 'reload' });
      if (res && res.ok) await cache.put(u, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.indexOf('sekaiisan-') === 0 && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// 本体：ネットワーク優先。取れたらキャッシュを入れ替え、取れなければキャッシュで開く。
// ⚠ 更新バーは `?v=` を変えて開き直すので、キャッシュの鍵は './' に正規化する
//   （クエリ付きで別の項目として溜めると、キャッシュが版ごとに増えていく）。
async function navigateNetworkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // ⚠ **`cache: 'no-cache'` を必ず付ける**（「キャッシュしない」ではなく
    //   「毎回サーバに再検証させる」の意味）。付けないと**ブラウザのHTTPキャッシュ**が
    //   古い本体を返し、デプロイ済みの新しい版が最大10分出てこない
    //   （GitHub Pages は `Cache-Control: max-age=600` を返す。実測で踏んだ）。
    //   変わっていなければ 304 なので、5.3MBを取り直すわけではない。
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok) cache.put('./', res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match('./');
    if (hit) return hit;
    throw e;
  }
}

// 版の中で変わらないファイル（PDF.js）はキャッシュ優先で十分
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;            // cdnjs などは触らない
  if (url.pathname.indexOf('/version.txt') !== -1) return; // ⚠ 更新検知の生命線
  if (url.pathname.indexOf('/sw.js') !== -1) return;       // 自分自身もキャッシュしない

  if (req.mode === 'navigate') { e.respondWith(navigateNetworkFirst(req)); return; }
  e.respondWith(cacheFirst(req));
});
