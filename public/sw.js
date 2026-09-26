/*
 * Service worker: the application shell works offline; market data never does.
 *
 * - Build output is precached (list injected at build time, see vite.config.ts).
 * - /api/* is NEVER cached: a price or a portfolio shown offline would be a stale
 *   fact presented as current. The app displays an explicit offline state instead.
 */
const BUILD = self.__BUILD_ID__ || 'dev';
const PRECACHE = self.__PRECACHE__ || ['/'];
const CACHE = `trevor-shell-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('trevor-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});
