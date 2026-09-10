"use client";

import { useEffect, useState } from "react";

// The Push API wants the VAPID public key as a raw Uint8Array, not the
// URL-safe base64 string it's normally shared as — this is the standard
// conversion (padding restored, URL-safe chars swapped back) every Web
// Push tutorial reaches for, not something specific to this app.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

type Status = "checking" | "unsupported" | "idle" | "enabled" | "denied";

// A single button that requests notification permission, subscribes this
// browser to Web Push via the already-registered service worker (see
// ServiceWorkerRegister.tsx/public/sw.js), and saves the subscription
// server-side (src/app/api/push/subscribe/route.ts) — after this, every
// notify() call anywhere in the app (src/lib/notify.ts) reaches this
// device as a real OS notification, even with the browser closed. Renders
// nothing on a browser that doesn't support Push (silently — this is a
// progressive enhancement, not a requirement to use the app) or while
// still checking the current subscription state.
export function NotificationPermissionButton({
  enableLabel,
  enabledLabel,
  deniedLabel,
}: {
  enableLabel: string;
  enabledLabel: string;
  deniedLabel: string;
}) {
  // Lazy initializer, not an effect — this check is a pure read of
  // capabilities that already exist the moment this component mounts, so
  // there's nothing to "synchronize" via an effect for the unsupported
  // case specifically; only the actual async subscription check below
  // needs one.
  const [status, setStatus] = useState<Status>(() =>
    typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) ? "unsupported" : "checking",
  );

  useEffect(() => {
    if (status !== "checking") return;
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        setStatus("enabled");
      } else if (Notification.permission === "denied") {
        setStatus("denied");
      } else {
        setStatus("idle");
      }
    });
  }, [status]);

  async function enable() {
    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) return;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setStatus("denied");
      return;
    }

    // Health audit (2026-09-10): the browser subscription and the server
    // registration used to be treated as one step — the fetch was neither
    // awaited for success nor guarded, and "enabled" was shown
    // unconditionally. A network failure surfaced as an unhandled
    // rejection with the button frozen mid-click, and a 500 from the
    // server showed a green tick for a subscription the server had never
    // recorded, so the driver was told they would get notifications they
    // would never receive.
    //
    // The browser subscription is rolled back on a server failure, so the
    // button stays honest: pressing it again re-subscribes cleanly rather
    // than finding an existing local subscription the server does not
    // know about (which the mount effect above would then report as
    // "enabled").
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
    try {
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) throw new Error(`push subscribe failed: ${res.status}`);
    } catch {
      await subscription.unsubscribe().catch(() => {});
      setStatus("idle");
      return;
    }
    setStatus("enabled");
  }

  if (status === "checking" || status === "unsupported") return null;

  if (status === "enabled") {
    return <span className="text-xs font-medium text-good">✓ {enabledLabel}</span>;
  }
  if (status === "denied") {
    return <span className="text-xs text-ink-faint">{deniedLabel}</span>;
  }

  return (
    <button
      onClick={enable}
      className="rounded-md border border-accent px-3 py-1.5 text-xs font-medium text-accent-strong"
    >
      {enableLabel}
    </button>
  );
}
