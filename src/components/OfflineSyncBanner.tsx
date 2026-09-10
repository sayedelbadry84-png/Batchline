"use client";

import { useCallback, useEffect, useState } from "react";
import { queueFor, listForeignQueues, getStorageAdapterForForeignScan, logicalKey, emitReplaySuccess, type RejectedAction, type ReplayOutcome, type ReadStatus } from "@/lib/offlineQueue";
import { recordActualField, authorizeOfflineQueueAdoption } from "@/app/(app)/production/actions";
import { toReplayOutcome } from "@/lib/recordActualFieldReplay";

// Registry of queueable action kinds this banner knows how to replay —
// see the "opt-in, not automatic" note on AutoSaveField's offlineQueueKind
// for why only idempotent field-overwrite actions ever appear here.
//
// This banner owns the transport only: build the FormData, call the
// Server Action. Deciding the ReplayOutcome from the server's typed
// answer is toReplayOutcome's job (src/lib/recordActualFieldReplay.ts) —
// PL-R15-P2-01, fifteenth production-lifecycle review, moved it there so
// the tests drive the REAL mapping instead of a paraphrase of it written
// into a fake handler, which is exactly how the text-vs-number
// comparison bug ("12.50" treated as a conflict with the server's own
// 12.5) survived a passing test.
const HANDLERS: Record<string, (fields: Record<string, string>) => Promise<ReplayOutcome>> = {
  recordActualField: async (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return toReplayOutcome(await recordActualField(fd), fields);
  },
};

export function OfflineSyncBanner({
  labels,
  queueIdentity,
}: {
  // BL-CR-P1-04, external-review validation (2026-09-10): the signed-in
  // user and site, from the server-rendered page. It selects the local
  // queue partition, so this banner never drains — or even displays —
  // readings that belong to somebody else's session on this device.
  queueIdentity: string;
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
    // "{n} readings on this device were saved by a different sign-in."
    foreignPending: string;
    foreignAdopt: string;
    foreignAdoptFailed: string;
    foreignAdoptForbidden: string;
  };
}) {
  // Memoized per identity inside the module, so this and every
  // AutoSaveField on the page share one partition.
  const offlineQueue = queueFor(queueIdentity);
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
  // Pending readings sitting in another partition on this device —
  // another account's, or the unattributed pre-partition queue. They are
  // never replayed automatically; this is only how an operator finds out
  // they are stranded here at all.
  const [foreign, setForeign] = useState<{ key: string; pending: number }[]>([]);
  const [adoptFailed, setAdoptFailed] = useState(false);
  const [adoptForbidden, setAdoptForbidden] = useState(false);

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
    setForeign(listForeignQueues(getStorageAdapterForForeignScan(), queueIdentity));
  }, [offlineQueue, queueIdentity]);

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
    // offlineQueue is memoized per identity in offlineQueue.ts, so this
    // effect re-subscribes only if the signed-in identity itself changes.
  }, [trySync, offlineQueue]);

  // The deliberate hand-back. Nothing here happens without this click:
  // the whole point of partitioning is that another sign-in's work is not
  // silently replayed under the current one's name.
  async function handleAdopt(key: string, pending: number) {
    setAdoptFailed(false);
    setAdoptForbidden(false);
    // PR4-R1: ask the server FIRST. Replaying these readings will file
    // them under the current account, so the decision needs the
    // permission for it and is recorded before anything moves.
    const fd = new FormData();
    fd.set("pending", String(pending));
    const authorized = await authorizeOfflineQueueAdoption(fd);
    if (authorized.status !== "OK") {
      setAdoptForbidden(true);
      return;
    }
    const result = await offlineQueue.adoptForeignQueue(key);
    if (result.status === "STORAGE_UNAVAILABLE") {
      setAdoptFailed(true);
      return;
    }
    setForeign(listForeignQueues(getStorageAdapterForForeignScan(), queueIdentity));
    await trySync();
  }

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
  if (!showStatusLine && rejected.length === 0 && readStatus === "OK" && foreign.length === 0) return null;

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
      {foreign.length > 0 && (
        <div role="alert" className="flex flex-col gap-1.5 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          {foreign.map((q) => (
            <div key={q.key} className="flex items-center justify-between gap-2">
              <span>{labels.foreignPending.replace("{n}", String(q.pending))}</span>
              <button type="button" onClick={() => handleAdopt(q.key, q.pending)} className="shrink-0 underline">
                {labels.foreignAdopt}
              </button>
            </div>
          ))}
          {adoptFailed && <div>{labels.foreignAdoptFailed}</div>}
          {adoptForbidden && <div>{labels.foreignAdoptForbidden}</div>}
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
