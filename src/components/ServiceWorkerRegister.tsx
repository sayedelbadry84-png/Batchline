"use client";

import { useEffect } from "react";

// Registers the app-shell service worker (public/sw.js) once, client-side
// only — nothing here runs during SSR. Silently no-ops in browsers/
// contexts without service worker support rather than erroring.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
