/*
  Nastivee AI service worker

  The old version served index.html from the cache for ever,
  so people kept running an out of date app. This one asks
  the network first for the page itself, and only falls back
  to the cache when the network is unavailable.

  Bump CACHE whenever the cached files change.
*/

/*
  The page registers this file as ./sw.js?v=APP_VERSION,
  so bumping APP_VERSION in index.html is enough to make
  the browser treat this as a new worker. The cache name
  follows that version so old caches are cleared.
*/

const VERSION =
  new URL(self.location.href).searchParams.get('v') || 'v3';

const CACHE = `nastivee-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './NAI-Logo.png'
];

self.addEventListener('install', event => {

  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );

});

self.addEventListener('activate', event => {

  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );

});

self.addEventListener('fetch', event => {

  const request = event.request;

  // Never touch API calls or anything that is not a plain GET
  if (
    request.method !== 'GET' ||
    request.url.startsWith('https://ai-8vlt.onrender.com/')
  ) {
    return;
  }

  const isPage =
    request.mode === 'navigate' ||
    request.url.endsWith('/') ||
    request.url.endsWith('index.html');

  if (isPage) {

    // Network first, so a new version is picked up straight away
    event.respondWith(
      fetch(request)
        .then(response => {

          const copy = response.clone();

          caches.open(CACHE)
            .then(cache => cache.put(request, copy))
            .catch(() => {});

          return response;

        })
        .catch(() => caches.match(request)
          .then(cached => cached || caches.match('./index.html')))
    );

    return;

  }

  // Everything else: cache first, refreshed in the background
  event.respondWith(
    caches.match(request).then(cached =>
      cached ||
      fetch(request).then(response => {

        const copy = response.clone();

        caches.open(CACHE)
          .then(cache => cache.put(request, copy))
          .catch(() => {});

        return response;

      })
    )
  );

});
