/* Service worker de «Mi tensión».
 * Estrategia: stale-while-revalidate para los assets propios (sirve al instante desde
 * caché y la actualiza en segundo plano). Para publicar una versión nueva, cambia
 * CACHE_VERSION: la caché antigua se borra al activarse. */
const CACHE_VERSION = 'v3';
const CACHE = `mi-tension-${CACHE_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mi-tension-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network); // actualiza en segundo plano
        return cached;
      }
      const res = await network;
      if (res) return res;
      // Sin red y sin caché: para navegaciones, devolver la app
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    })
  );
});
