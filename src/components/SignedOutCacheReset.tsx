"use client";

import { useEffect } from "react";

// BL-CR-P1-03, external-review validation (2026-09-10): the sign-out half
// of the service worker's cache protocol.
//
// logout() clears the server session and the cookie; neither of those
// touches CacheStorage, which is shared by every user of the device. The
// worker no longer caches any authenticated response (see public/sw.js),
// so this is defence in depth rather than the fix itself — it guarantees
// that anything a later change starts caching at runtime is dropped the
// moment a session ends.
//
// Rendered by the login page because that is where every sign-out lands,
// and it is the one screen guaranteed to be reached with no session. It
// runs on an ordinary first visit too, which is harmless: only non-public
// entries are removed, and there are none to remove. It deliberately does
// NOT touch localStorage — unsynced operator readings live there
// (src/lib/offlineQueue.ts) and destroying them would throw away work
// that has not reached the server yet.
export function SignedOutCacheReset() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: "BATCHLINE_SIGNED_OUT" }))
      .catch(() => {});
  }, []);
  return null;
}
