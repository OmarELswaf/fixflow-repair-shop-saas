/* FixFlow service worker — hand-written, no Workbox / vite-plugin-pwa.
 * Static shell and static assets ONLY. Network-only for /api.
 * Never caches authenticated API responses, invoices, or customer photos.
 * Must stay in sync with apps/web/src/pwa/pwa.ts shouldCache().
 */
const CACHE_NAME = 'fixflow-shell-v1';
const SHELL = ['/', '/offline.html', '/manifest.webmanifest'];

function shouldCache(url) {
  const parsed = new URL(url, self.location.origin);
  if (parsed.origin !== self.location.origin) return false;
  const path = parsed.pathname;
  if (parsed.search || parsed.hash) return false;
  if (path === '/' || path === '/offline.html' || path === '/manifest.webmanifest') return true;
  if (/^\/assets\/[a-zA-Z0-9_/-]+\.(js|css|woff2?)$/.test(path)) return true;
  if (/^\/icons\/icon-(192|512)\.png$/.test(path) || path === '/icons/icon.svg') return true;
  return false;
}

self.addEventListener('install', (event) => {
  // Install in the background. Do NOT call skipWaiting here:
  // activation happens only after the user confirms in the app.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Network-only for /api and anything not cacheable.
  if (!shouldCache(request.url)) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (
            response.ok &&
            response.type === 'basic' &&
            !/no-store|private/i.test(response.headers.get('Cache-Control') || '')
          ) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match('/offline.html')),
    );
    return;
  }
  // Cache-first for same-origin static assets.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (
            response.ok &&
            response.type === 'basic' &&
            !/no-store|private/i.test(response.headers.get('Cache-Control') || '')
          ) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        }),
    ),
  );
});
