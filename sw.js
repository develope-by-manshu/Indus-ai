// Minimal service worker — required for PWA installability.
// Caches nothing fancy; just lets the browser (and PWABuilder) recognize this as installable.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Pass everything straight through to the network as normal.
  event.respondWith(fetch(event.request));
});
