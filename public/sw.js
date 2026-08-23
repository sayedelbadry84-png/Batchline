// Minimal app-shell service worker — no Workbox, no build step. Scope is
// deliberately narrow: cache static assets and page shells for offline/
// flaky-connectivity loading (the batching floor and yard are exactly
// where this matters), and never touch POST requests (Server Actions) —
// those need to reach the server or fail loudly, not serve a stale cached
// response. Actual offline *writes* are handled at the app level (see
// src/lib/offlineQueue.ts), not here.
const CACHE_NAME = "batchline-shell-v1";
const APP_SHELL = ["/operator", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // Server Actions and API writes pass straight through
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Static build assets change filename on every deploy (content-hashed),
  // so cache-first is always safe and fast.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      })),
    );
    return;
  }

  // Page navigations: network-first (always prefer fresh data when
  // online), falling back to the last cached shell when the network
  // fails — the yard/floor scenario this whole feature exists for.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/operator"))),
    );
  }
});
