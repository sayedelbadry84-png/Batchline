// Minimal app-shell service worker — no Workbox, no build step. Scope is
// deliberately narrow: cache content-hashed static assets and one
// data-free offline shell, and never touch POST requests (Server Actions)
// — those need to reach the server or fail loudly, not serve a stale
// cached response. Actual offline *writes* are handled at the app level
// (see src/lib/offlineQueue.ts), not here.
//
// BL-CR-P1-03, external-review validation (2026-09-10): this worker used
// to precache /operator, /driver and /pump-crew and to store EVERY
// successful navigation response in one origin-wide cache. Those are
// authenticated, per-user server-rendered pages. CacheStorage is not
// partitioned by identity and signing out clears only the server session
// and the cookie, so on a shared plant tablet the next person — or the
// same device with no session at all, offline — could be served the
// previous user's rendered operational data. Normal HTTP cache directives
// do not help: an explicit cache.put() stores the response regardless.
//
// The rule now: NO authenticated navigation response is ever written to
// the cache. What survives offline is the static asset payload plus
// /offline, a page that renders no record of any kind. The role screens
// come back the moment the network does, from the server, under whatever
// session is actually current.
const CACHE_NAME = "batchline-shell-v2";
const OFFLINE_SHELL = "/offline";
// /offline is server-rendered and therefore carries the root layout's
// per-site accent colour (see getActiveSiteAccentColor) — a brand colour,
// not personal or operational data, and the only thing about this page
// that is not identical for every visitor.
const APP_SHELL = [OFFLINE_SHELL, "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Renaming the cache to -v2 is what evicts the v1 bucket on every
    // device that already has one, along with whatever authenticated HTML
    // it accumulated. Deliberately only touches CacheStorage: unsynced
    // operator readings live in localStorage (offlineQueue.ts) and must
    // survive this untouched.
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
  // so cache-first is always safe and fast. These are the same bytes for
  // every user, signed in or not — nothing identity-bound is stored here.
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

  // Page navigations: straight to the network, and the response is NEVER
  // stored — see the note at the top of this file. When the network
  // fails, the data-free /offline shell is served instead. A driver who
  // loses signal in the yard gets a page that tells them their queued
  // readings are safe, rather than another person's screen.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_SHELL)));
  }
});

// Explicit sign-out protocol (BL-CR-P1-03). Nothing user-specific is
// cached any more, so this is defence in depth rather than the fix
// itself: it guarantees that anything a future change starts caching at
// runtime is dropped when the session ends. The precached shell is kept
// (it is public and is what makes the next offline load work at all), and
// localStorage — where unsynced readings live — is deliberately not
// touched from here: clearing it would destroy work the operator has not
// been able to send yet.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "BATCHLINE_SIGNED_OUT") return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.keys().then((requests) =>
        Promise.all(
          requests.map((req) => {
            const path = new URL(req.url).pathname;
            const isPublicShell = APP_SHELL.includes(path) || path.startsWith("/_next/static/");
            return isPublicShell ? Promise.resolve(false) : cache.delete(req);
          }),
        ),
      ),
    ),
  );
});

// Web Push — the payload is whatever notify() in src/lib/notify.ts sent
// (see src/lib/push.ts), a plain { title, body, link } JSON object, not a
// push-provider-specific shape. Falls back to a generic title if the
// payload is somehow missing/malformed rather than silently dropping the
// notification the OS already woke this worker up for.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall through to the generic title below.
  }
  const title = payload.title || "Batchline";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { link: payload.link || "/driver" },
    }),
  );
});

// Tapping the notification focuses an already-open tab on that link if
// one exists, rather than always opening a fresh one — the common case
// for a driver who already has the app open in the background.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data && event.notification.data.link ? event.notification.data.link : "/driver";
  const targetUrl = new URL(link, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
