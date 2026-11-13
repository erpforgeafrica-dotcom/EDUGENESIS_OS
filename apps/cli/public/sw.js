/* EduGenesis OS — service worker (shell cache only).
 *
 * Rules, in order of importance:
 *
 *   1. NEVER intercept /api/. A settings read or write must always reach the
 *      server; a cached settings response is a lie about stored state, and a
 *      cached write would silently drop a change.
 *   2. Navigations are network-first, so a redeploy is visible immediately and
 *      the cached shell is only a fallback when the network is gone.
 *   3. Static shell assets are cache-first, versioned by CACHE_NAME. Bump the
 *      version to invalidate the shell.
 *
 * The cache is a convenience, never a source of truth. Settings live in the
 * project folder; learner progress lives on the device or in the server store.
 */
const CACHE_NAME = 'edugenesis-shell-v1';

const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/assets/edugenesis-tokens.css',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name !== CACHE_NAME;
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;

  // A write is never served from, or stored in, a cache.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Rule 1: the API is never cached.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            return cache.put('/', copy);
          });
          return response;
        })
        .catch(function () {
          return caches.match('/').then(function (cached) {
            return cached || Response.error();
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).then(function (response) {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            return cache.put(request, copy);
          });
        }
        return response;
      });
    })
  );
});
