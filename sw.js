// Service worker: app shell precached; OCR engine + language data cached on first use.
const VERSION = 'v1.2.1';
const SHELL = `bt-shell-${VERSION}`;
const OCR = 'bt-ocr-v1';
const THA_LANG = 'vendor/tesseract/lang/tha.traineddata.gz'; // 泰文（fast）；放進 OCR 快取，離線可用
const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'tokens.css', 'js/app.js', 'js/db.js', 'js/policy.js', 'js/reconcile.js', 'js/icons.js', 'js/ocr.js', 'js/dateparse.js', 'js/image.js', 'js/export.js',
  'vendor/exceljs.min.js', 'vendor/jszip.min.js',
  'assets/template_blank.xlsx',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png',
];
self.addEventListener('install', (e) => { e.waitUntil(Promise.all([
    // 先整批預快取；任何一個檔 404 會讓 addAll 整批失敗 → 改逐檔加入，少數缺檔不再讓 install 失敗（避免新舊檔混用）
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES).catch(async (err) => {
      console.warn('precache addAll failed, retry per file', err);
      const miss = [];
      await Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => miss.push(f))));
      if (miss.length) console.warn('precache missing files:', miss);
    })),
    // tha 檔不在時不擋安裝（仍可用設定頁「預先下載」補），但 console 會警告
    caches.open(OCR).then((c) => c.add(THA_LANG)).catch((err) => console.warn('tha precache failed', err)),
  ]).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('bt-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/tesseract/')) {
    // cache-first, store on first use (large files, rarely change)
    e.respondWith(caches.open(OCR).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true }); if (hit) return hit;
      const res = await fetch(e.request); if (res.ok) c.put(e.request, res.clone()); return res;
    }));
    return;
  }
  // app shell: cache-first, refresh in background
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => hit || caches.match('index.html'));
    return hit || net;
  }));
});
