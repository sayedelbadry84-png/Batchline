"use client";

import { useCallback, useEffect, useState } from "react";
import { flushQueue, peekQueue } from "@/lib/offlineQueue";
import { recordActualField } from "@/app/(app)/production/actions";

// Registry of queueable action kinds this banner knows how to replay —
// see the "opt-in, not automatic" note on AutoSaveField's offlineQueueKind
// for why only idempotent field-overwrite actions ever appear here.
const HANDLERS: Record<string, (fields: Record<string, string>) => Promise<void>> = {
  recordActualField: async (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    await recordActualField(fd);
  },
};

export function OfflineSyncBanner({
  labels,
}: {
  labels: { offline: string; pending: (n: number) => string; synced: string };
}) {
  // Lazy initializers (not a synchronous setState in the effect body) —
  // guarded for SSR, where navigator/localStorage don't exist.
  const [pendingCount, setPendingCount] = useState(() => (typeof window === "undefined" ? 0 : peekQueue().length));
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [justSynced, setJustSynced] = useState(false);

  const trySync = useCallback(async () => {
    const { flushed, remaining } = await flushQueue(HANDLERS);
    setPendingCount(remaining);
    if (flushed > 0) {
      setJustSynced(true);
      setTimeout(() => setJustSynced(false), 2500);
    }
  }, []);

  useEffect(() => {
    const initialSync = window.setTimeout(trySync, 0);

    const onOnline = () => { setIsOnline(true); trySync(); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    // A blur→save can queue an item without the browser ever firing
    // "offline" (e.g. a request that just times out) — a light poll
    // catches that case too, without needing a broadcast channel.
    const poll = window.setInterval(() => setPendingCount(peekQueue().length), 5000);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(poll);
    };
  }, [trySync]);

  if (isOnline && pendingCount === 0 && !justSynced) return null;

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        !isOnline ? "border-warn/30 bg-warn-soft text-warn" : "border-good/30 bg-good-soft text-good"
      }`}
    >
      {!isOnline ? labels.offline : pendingCount > 0 ? labels.pending(pendingCount) : labels.synced}
    </div>
  );
}
