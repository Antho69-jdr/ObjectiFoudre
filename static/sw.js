const CACHE_NAME = 'storm-chase-v0.6.5';
const ASSETS = [
  '/',
  '/static/storm-chase.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/logo-objectif-foudre.svg',
  '/static/storm-chase.webmanifest?v=0.6.1'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response && response.ok) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (_) {
      const cached = await cache.match(event.request, { ignoreSearch: false });
      if (cached) return cached;
      return caches.match('/');
    }
  })());
});
