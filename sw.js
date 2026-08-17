// Minimal service worker for Indus AI — enables PWA installability
// (Add to Home Screen / APK packaging) and basic offline resilience.
// It does NOT cache chat responses (those must always be fresh),
// it only caches the static app shell so the site opens instantly
// and still loads (with a friendly offline message) with no signal.

const CACHE_NAME = 'indus-ai-shell-v1';
const APP_SHELL = [
  '/',
  '/app.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't fail install if a shell file is briefly unreachable
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never cache API calls — chat, image generation, and auth must always hit the network.
  if (req.url.includes('/api/')) return;

  // Network-first for navigations (HTML pages), falling back to cache, then a
  // minimal offline message if truly offline and nothing cached yet.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('/app.html'))
        )
    );
    return;
  }

  // Cache-first for static assets (icons, etc.), falling back to network.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});
