"use client";

import { useCallback, useEffect, useState } from "react";
import { flushQueue, peekQueue, peekRejected, dismissRejected, type RejectedAction, type ReplayOutcome } from "@/lib/offlineQueue";
import { recordActualField } from "@/app/(app)/production/actions";

// Registry of queueable action kinds this banner knows how to replay —
// see the "opt-in, not automatic" note on AutoSaveField's offlineQueueKind
// for why only idempotent field-overwrite actions ever appear here.
//
// Maps recordActualField's own typed result to a ReplayOutcome (PL-R6-
// P2-02, sixth production-lifecycle review) — OK is the only APPLIED
// outcome; every other typed status is REJECTED (the business write was
// genuinely refused, replaying it again would refuse it again forever);
// a thrown exception (still offline, a real transport error) is left to
// flushQueue's own try/catch, which treats it as RETRYABLE.
const HANDLERS: Record<string, (fields: Record<string, string>) => Promise<ReplayOutcome>> = {
  recordActualField: async (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const result = await recordActualField(fd);
    return result.status === "OK" ? { status: "APPLIED" } : { status: "REJECTED", reason: result.status };
  },
};

export function OfflineSyncBanner({
  labels,
}: {
  // pendingOther/rejectedOther carry a literal "{n}" placeholder, filled
  // in below — not functions (PL-R5-P1-02, fifth production-lifecycle
  // review): a function crossing the Server→Client boundary from the
  // page that renders this Client Component is not serializable. Plain
  // Record objects (fieldLabels/reasonLabels) are fine — only functions
  // are the problem.
  labels: {
    offline: string;
    pendingOne: string;
    pendingOther: string;
    synced: string;
    rejectedOne: string;
    rejectedOther: string;
    fieldLabels: Record<string, string>;
    reasonLabels: Record<string, string>;
    dismiss: string;
  };
}) {
  // Lazy initializers (not a synchronous setState in the effect body) —
  // guarded for SSR, where navigator/localStorage don't exist.
  const [pendingCount, setPendingCount] = useState(() => (typeof window === "undefined" ? 0 : peekQueue().length));
  const [rejected, setRejected] = useState<RejectedAction[]>(() => (typeof window === "undefined" ? [] : peekRejected()));
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [justSynced, setJustSynced] = useState(false);

  const trySync = useCallback(async () => {
    const { flushed, remaining } = await flushQueue(HANDLERS);
    setPendingCount(remaining);
    setRejected(peekRejected());
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

  function handleDismiss(id: string) {
    dismissRejected(id);
    setRejected(peekRejected());
  }

  const showStatusLine = isOnline === false || pendingCount > 0 || justSynced;
  if (!showStatusLine && rejected.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {showStatusLine && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            !isOnline ? "border-warn/30 bg-warn-soft text-warn" : "border-good/30 bg-good-soft text-good"
          }`}
        >
          {!isOnline
            ? labels.offline
            : pendingCount > 0
              ? (pendingCount === 1 ? labels.pendingOne : labels.pendingOther.replace("{n}", String(pendingCount)))
              : labels.synced}
        </div>
      )}
      {rejected.length > 0 && (
        <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
          <div>{rejected.length === 1 ? labels.rejectedOne : labels.rejectedOther.replace("{n}", String(rejected.length))}</div>
          <ul className="flex flex-col gap-1">
            {rejected.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2">
                <span>
                  {labels.fieldLabels[item.fields.field] ?? item.fields.field}: {item.fields.value} — {labels.reasonLabels[item.reason] ?? item.reason}
                </span>
                <button type="button" onClick={() => handleDismiss(item.id)} className="shrink-0 underline">
                  {labels.dismiss}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
