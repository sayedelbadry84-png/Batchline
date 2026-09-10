"use client";

import { useCallback, useEffect, useState } from "react";
import { offlineQueue, logicalKey, emitReplaySuccess, type RejectedAction, type ReplayOutcome, type ReadStatus } from "@/lib/offlineQueue";
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
    // PL-R12-P1-01, twelfth production-lifecycle review: the version is
    // returned to flushQueue rather than published from inside the
    // handler. Publishing here fired BEFORE the settlement was durably
    // stored — and before it was known whether this replay's own
    // generation was still the current one — so a superseded or unstored
    // replay could still tell the mounted field "saved, here is your new
    // version". flushQueue now publishes through onSettled below, only
    // once the settlement has actually persisted.
    if (result.status === "OK") return { status: "APPLIED", version: result.version };

    // PL-R14-P2-03, fourteenth production-lifecycle review: a
    // STALE_READING whose current server value IS the value we just sent
    // means this exact reading already applied — almost always THIS
    // client's own earlier attempt, whose local settlement failed to
    // save. Treating it as a conflict dead-lettered the operator's own
    // accepted reading and asked them to re-enter a number the database
    // already held. The in-memory reconciliation in offlineQueue.ts only
    // covers one session; this covers a reload, another tab, or another
    // device, because it is decided from the server's own response.
    // Either way the outcome is the same: the queued value is what the
    // server holds, so the item is settled at the server's version.
    if (result.status === "STALE_READING" && result.currentValue !== null && String(result.currentValue) === fields.value) {
      return { status: "APPLIED", version: result.currentVersion };
    }
    return { status: "REJECTED", reason: result.status };
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
    storageError: string;
    corruptionRecovered: string;
  };
}) {
  // Lazy initializers (not a synchronous setState in the effect body) —
  // guarded for SSR, where navigator/localStorage don't exist.
  const [pendingCount, setPendingCount] = useState(() => (typeof window === "undefined" ? 0 : offlineQueue.peekQueue().items.length));
  const [rejected, setRejected] = useState<RejectedAction[]>(() => (typeof window === "undefined" ? [] : offlineQueue.peekRejected().items));
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [justSynced, setJustSynced] = useState(false);
  // PL-R8-P1-02, eighth production-lifecycle review: readStatus (not a
  // plain boolean) — "storage genuinely unreadable/unwritable right now"
  // and "a corrupt payload was just recovered from" are different
  // situations an operator needs different words for, and this banner
  // must never silently render "nothing pending" for either one (the
  // reviewed finding: a peekQueue()/peekRejected() that returns an empty
  // array on a READ failure looks identical to a genuinely empty queue).
  const [readStatus, setReadStatus] = useState<ReadStatus>("OK");

  const trySync = useCallback(async () => {
    const { flushed, remaining, readStatus: flushReadStatus } = await offlineQueue.flushQueue(HANDLERS, {
      // PL-R10-P1-03: the mounted AutoSaveField that queued this reading
      // has no way to learn the server's fresh version on its own — its
      // next save would otherwise carry the stale pre-offline version and
      // be refused as STALE_READING for no real conflict. PL-R12-P1-01
      // moved this out of the handler: it now fires only once the
      // settlement is DURABLY STORED, and for a superseded item the
      // successor's own expectedVersion has already been advanced to the
      // same number in storage, so the ref and the queue agree.
      onSettled: (item, outcome) => {
        if (outcome.status !== "APPLIED" || typeof outcome.version !== "number") return;
        emitReplaySuccess(logicalKey(item.kind, item.fields), outcome.version);
      },
    });
    const rejectedRead = offlineQueue.peekRejected();
    setPendingCount(remaining);
    setRejected(rejectedRead.items);
    // Worst-of the two reads this tick performed — STORAGE_UNAVAILABLE
    // outranks RECOVERED_FROM_CORRUPT, which outranks OK.
    setReadStatus(flushReadStatus === "STORAGE_UNAVAILABLE" || rejectedRead.readStatus === "STORAGE_UNAVAILABLE" ? "STORAGE_UNAVAILABLE" : flushReadStatus === "RECOVERED_FROM_CORRUPT" || rejectedRead.readStatus === "RECOVERED_FROM_CORRUPT" ? "RECOVERED_FROM_CORRUPT" : "OK");
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
    const poll = window.setInterval(() => {
      const read = offlineQueue.peekQueue();
      setPendingCount(read.items.length);
      if (read.readStatus !== "OK") setReadStatus(read.readStatus);
    }, 5000);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.clearInterval(poll);
    };
  }, [trySync]);

  async function handleDismiss(id: string) {
    // PL-R7-P1-02: only reflect the dismissal in the UI once persistence
    // of that removal actually succeeded — re-reading peekRejected()
    // (rather than filtering local state directly) means a failed
    // persist leaves the item showing exactly as it did before.
    const result = await offlineQueue.dismissRejected(id);
    if (result.status !== "OK") setReadStatus("STORAGE_UNAVAILABLE");
    setRejected(offlineQueue.peekRejected().items);
  }

  const showStatusLine = isOnline === false || pendingCount > 0 || justSynced;
  if (!showStatusLine && rejected.length === 0 && readStatus === "OK") return null;

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
      {readStatus === "STORAGE_UNAVAILABLE" && (
        <div role="alert" className="rounded-lg border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
          {labels.storageError}
        </div>
      )}
      {readStatus === "RECOVERED_FROM_CORRUPT" && (
        <div role="alert" className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          {labels.corruptionRecovered}
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
