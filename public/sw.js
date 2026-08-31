// Minimal app-shell service worker — no Workbox, no build step. Scope is
// deliberately narrow: cache static assets and page shells for offline/
// flaky-connectivity loading (the batching floor and yard are exactly
// where this matters), and never touch POST requests (Server Actions) —
// those need to reach the server or fail loudly, not serve a stale cached
// response. Actual offline *writes* are handled at the app level (see
// src/lib/offlineQueue.ts), not here.
const CACHE_NAME = "batchline-shell-v1";
// Both offline-relevant shells — the plant-floor tablet UI and the
// driver's own mobile UI, two different roles, two different pages. Both
// get precached so an offline navigation can fall back to whichever one
// actually matches what the user was trying to reach (see the fetch
// handler below) instead of always bouncing everyone to /operator.
const OPERATOR_SHELL = "/operator";
const DRIVER_SHELL = "/driver";
const APP_SHELL = [OPERATOR_SHELL, DRIVER_SHELL, "/manifest.json", "/icon.svg"];

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
  // fails — the yard/floor scenario this whole feature exists for. The
  // fallback shell matches the role the failed navigation was actually
  // for (driver vs. operator) — a driver who goes offline mid-shift must
  // land back on their own /driver shell, not get bounced into the
  // plant-operator UI just because that's the only shell this worker used
  // to remember.
  if (request.mode === "navigate") {
    const fallbackShell = url.pathname.startsWith(DRIVER_SHELL) ? DRIVER_SHELL : OPERATOR_SHELL;
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(fallbackShell))),
    );
  }
});
