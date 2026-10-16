// Paths are relative to this worker's location (/studio/dj/sw.js), so it only
// controls the mixer, never the rest of the Piko FG site it is served under.
const BASE = new URL('./', self.location).pathname; // "/studio/dj/"
const CACHE_NAME = 'pro-dj-studio-v2';
const STATIC_CACHE_NAME = 'pro-dj-studio-static-v2';
// The page itself has no trailing slash (Next.js redirects /studio/dj/ to /studio/dj).
const SHELL_URL = BASE.slice(0, -1);
const APP_SHELL = [SHELL_URL, `${BASE}manifest.json`, `${BASE}favicon.ico`, `${BASE}workers/analyzer.worker.js`, `${BASE}worklets/bitcrusher-processor.js`];
const isStaticAsset = (url) =>
  url.pathname.startsWith(`${BASE}_next/static/`) ||
  url.pathname.startsWith(`${BASE}workers/`) ||
  url.pathname.startsWith(`${BASE}worklets/`);

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
      caches.open(STATIC_CACHE_NAME),
    ])
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => ![CACHE_NAME, STATIC_CACHE_NAME].includes(key))
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, clone));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(SHELL_URL) || Response.error()))
    );
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            cache.put(request, response.clone());
            return response;
          });
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const cloned = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
        return response;
      });
    })
  );
});
