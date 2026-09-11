const CACHE_NAME = 'objectifoudre-v1.3.280';
// Préchargement volontairement limité aux URLs SANS numéro de version. Les entrées
// versionnées ont été RETIRÉES (v1.3.280) : elles étaient figées à `?v=1.3.205`, 74
// versions en retard, et `cache.match(..., { ignoreSearch: false })` ne les aurait
// JAMAIS fait correspondre aux requêtes réelles (`?v=<version courante>`). Elles
// coûtaient un téléchargement complet de MapLibre (800 Ko) à chaque installation
// pour un cache que personne ne pouvait lire. Le reste se met en cache tout seul au
// fil des requêtes réussies (`cache.put` plus bas), avec la bonne clé.
const ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png'
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
        return response;
      }
      // Réponse d'ERREUR (404, 5xx). Avant v1.3.280 on la rendait telle quelle : un
      // hoquet d'une seconde pendant un déploiement suffisait à faire échouer un
      // <script>, et l'app mourait. On sert la copie déjà connue quand on en a une.
      // AUCUNE nouvelle tentative réseau ici : un repli, pas une reprise — rien qui
      // puisse marteler le serveur au moment précis où il tousse.
      // Réservé aux ressources statiques : resservir une réponse d'API périmée
      // ferait mentir l'app sur des données météo.
      if (!url.pathname.startsWith('/api/')) {
        const secours = await cache.match(event.request, { ignoreSearch: false });
        if (secours) return secours;
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
