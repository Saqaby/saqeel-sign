// Network first so updates show at once; the cache only serves when offline.
const CACHE = 'sign-v5';
const SHELL = [
  './', 'style.css?v=5', 'app.js?v=5', 'lib/fonts/tajawal.css?v=5',
  'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/pdf-lib.min.js',
  'lib/fonts/tajawal-400-arabic.woff2', 'lib/fonts/tajawal-400-latin.woff2',
  'lib/fonts/tajawal-500-arabic.woff2', 'lib/fonts/tajawal-500-latin.woff2',
  'lib/fonts/tajawal-700-arabic.woff2', 'lib/fonts/tajawal-700-latin.woff2',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error())))
  );
});
