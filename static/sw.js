const CACHE_NAME = 'objectifoudre-v1.3.268';
const ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/logo-splash.png?v=1.3.205',
  '/assets/vendor/maplibre/maplibre-gl.js?v=1.3.205',
  '/assets/vendor/maplibre/maplibre-gl.css?v=1.3.205',
  '/assets/vendor/carto/dark-matter-style.json?v=1.3.205',
  '/manifest.webmanifest?v=1.3.205',
  '/assets/dist/theme.css?v=1.3.205',
  '/assets/dist/app.js?v=1.3.205'
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
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const isNavigation = event.request.mode === 'navigate';

    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response && response.ok) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (_) {
      const cached = await cache.match(event.request, { ignoreSearch: false });
      if (cached) return cached;
      if (isNavigation) return caches.match('/');
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

// ── Notifications push (alertes orage par département, Phase 4) ───────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { try { data = { body: event.data.text() }; } catch (__) { data = {}; } }
  const title = data.title || 'ObjectiFoudre — alerte orage';
  const options = {
    body: data.body || 'Activité orageuse détectée sur ton secteur.',
    icon: data.icon || '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    tag: data.tag || 'objf-storm',
    renotify: !!data.tag,
    data: { url: data.url || '/' },
    vibrate: [80, 40, 80]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try { if ('navigate' in client) await client.navigate(target); } catch (_) {}
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
