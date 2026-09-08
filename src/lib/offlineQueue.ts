// A small localStorage-backed retry queue for the ONE class of action
// where blindly replaying a queued write is actually safe: overwriting a
// single field with the latest value (recordActualField — a batching-
// floor scale reading). Deliberately not used for actions that create a
// new row or transition state (releaseBatchTicket, completeBatch,
// startTrip) — replaying those twice on reconnect would double-book a
// ticket or double-deduct inventory, which is worse than the operator
// just re-tapping "release" once they're back online.
export type QueuedAction = {
  id: string;
  kind: string;
  fields: Record<string, string>;
  createdAt: number;
};

export type RejectedAction = QueuedAction & { reason: string; rejectedAt: number };

// A handler's outcome, not a bare Promise<void> (PL-R6-P2-02, sixth
// production-lifecycle review): a resolved promise used to be treated as
// success unconditionally, so a handler whose underlying Server Action
// rejected the business write by returning a typed non-OK result — not
// by throwing — was dequeued and counted as flushed anyway, permanently
// discarding a reading that was never actually stored. APPLIED is the
// only outcome that dequeues silently; RETRYABLE leaves the item queued
// (same as a thrown exception always has); REJECTED moves it to a
// visible dead-letter list instead of deleting it, so a supervisor can
// still see the discarded value and why.
export type ReplayOutcome = { status: "APPLIED" } | { status: "RETRYABLE" } | { status: "REJECTED"; reason: string };

export type PersistResult = { status: "OK" } | { status: "STORAGE_UNAVAILABLE"; error?: unknown };

// PL-R7-P1-02, seventh production-lifecycle review: a real storage
// adapter, injectable — not a hardcoded `window.localStorage` reference
// — so failure behavior (quota exceeded, private-browsing denial,
// corrupt payload) is testable in plain node:test without a browser,
// and so a genuine persistence failure can be reported to the caller
// instead of swallowed. Storage-backed since a real browser's
// `localStorage` throws synchronously on both get and set in some
// failure modes (Safari private mode denies even reading it).
export type StorageAdapter = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getDefaultStorage(): StorageAdapter | null {
  if (typeof window === "undefined") return null;
  try {
    // Accessing the property itself can throw (Safari private mode) —
    // this touches it before deciding it's usable.
    const ls = window.localStorage;
    if (!ls) return null;
    return ls;
  } catch {
    return null;
  }
}

const STORAGE_KEY = "bl_offline_queue_v1";

type OfflineStateV1 = { version: 1; pending: QueuedAction[]; rejected: RejectedAction[] };

function emptyState(): OfflineStateV1 {
  return { version: 1, pending: [], rejected: [] };
}

function isOfflineStateV1(value: unknown): value is OfflineStateV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { pending?: unknown }).pending) &&
    Array.isArray((value as { rejected?: unknown }).rejected)
  );
}

// Reads the ENTIRE queue as one object — pending and rejected are two
// fields of the SAME persisted value, not two separate storage keys, so
// a pending→rejected transition (or any other) is always a single
// setItem call, never two writes with a loss window between them
// (PL-R7-P1-02).
function readState(storage: StorageAdapter): OfflineStateV1 {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return emptyState();
  }
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isOfflineStateV1(parsed)) return parsed;
  } catch {
    // fall through to the corrupt-payload handling below
  }
  // Corrupt or unrecognized shape — never silently discard it. Back it
  // up under a distinct key (best-effort; a failure here just means the
  // backup itself couldn't be written) and warn loudly, then replace
  // STORAGE_KEY itself with a fresh empty state — not merely returning
  // one in memory — so a later read of the same still-corrupt payload
  // doesn't back it up again under yet another key on every single call.
  const backupKey = `${STORAGE_KEY}_corrupt_backup_${Date.now()}`;
  try {
    storage.setItem(backupKey, raw);
  } catch {
    // best-effort only
  }
  if (typeof console !== "undefined") {
    console.warn("[offlineQueue] stored state was corrupt or an unrecognized shape; backed up under a separate key and starting fresh.", raw);
  }
  const fresh = emptyState();
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    // If even this fails, the original corrupt raw string is still
    // sitting under STORAGE_KEY untouched — nothing is lost, this read
    // just returns an in-memory empty state for THIS call only, and the
    // next read will go through this same recovery path again.
  }
  return fresh;
}

function persistState(storage: StorageAdapter, next: OfflineStateV1): PersistResult {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return { status: "OK" };
  } catch (error) {
    // Quota exceeded, storage disabled/blocked, or any other reason
    // setItem can throw — the caller must treat this as "not saved",
    // never as success (PL-R7-P1-02: this used to be swallowed here
    // with nothing returned, so enqueue/dequeue/dismiss all looked like
    // they had worked even when nothing was actually persisted).
    return { status: "STORAGE_UNAVAILABLE", error };
  }
}

export type EnqueueResult = { status: "OK"; item: QueuedAction } | { status: "STORAGE_UNAVAILABLE" };

// A factory, not a module-level singleton bound to `window.localStorage`
// directly (PL-R7-P1-02) — the default export below is what the app
// actually uses, but tests construct their own instance over a fake
// StorageAdapter (including one that always throws) to exercise failure
// paths deterministically, with no browser/jsdom involved.
export function createOfflineQueue(storage: StorageAdapter | null) {
  function peekQueue(): QueuedAction[] {
    return storage ? readState(storage).pending : [];
  }

  function peekRejected(): RejectedAction[] {
    return storage ? readState(storage).rejected : [];
  }

  function enqueue(kind: string, fields: Record<string, string>): EnqueueResult {
    if (!storage) return { status: "STORAGE_UNAVAILABLE" };
    const state = readState(storage);
    const item: QueuedAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, fields, createdAt: Date.now() };
    const result = persistState(storage, { version: 1, pending: [...state.pending, item], rejected: state.rejected });
    return result.status === "OK" ? { status: "OK", item } : { status: "STORAGE_UNAVAILABLE" };
  }

  function dismissRejected(id: string): PersistResult {
    if (!storage) return { status: "STORAGE_UNAVAILABLE" };
    const state = readState(storage);
    return persistState(storage, { version: 1, pending: state.pending, rejected: state.rejected.filter((item) => item.id !== id) });
  }

  // Replays every queued item whose kind has a matching handler.
  // APPLIED and REJECTED each commit their pending→(gone|rejected)
  // transition as ONE persistState call carrying the full next state —
  // never a dequeue followed by a separate rejected-list write
  // (PL-R7-P1-02's own "two non-atomic writes" finding). If that single
  // write fails, the item is left exactly as it was in storage (still
  // pending), never partially transitioned.
  async function flushQueue(
    handlers: Record<string, (fields: Record<string, string>) => Promise<ReplayOutcome>>,
  ): Promise<{ flushed: number; remaining: number; rejected: number; storageError: boolean }> {
    if (!storage) return { flushed: 0, remaining: 0, rejected: 0, storageError: true };
    const state = readState(storage);
    let flushed = 0;
    let storageError = false;

    for (const item of state.pending) {
      const handler = handlers[item.kind];
      if (!handler) continue;
      let outcome: ReplayOutcome;
      try {
        outcome = await handler(item.fields);
      } catch {
        continue; // Still offline, or a real transport error — leave it queued, unchanged.
      }
      if (outcome.status === "RETRYABLE") continue; // leave it queued, exactly as-is, for the next flush.

      // Re-read the FRESHEST state right before this one item's write,
      // not the snapshot flushQueue started with — two concurrent
      // flushQueue calls (e.g. two open tabs on the same ticket) can
      // otherwise each work from a stale snapshot and clobber each
      // other's already-persisted removals.
      const fresh = readState(storage);
      if (!fresh.pending.some((i) => i.id === item.id)) {
        // Already gone — a concurrent flushQueue call already resolved
        // this exact item (APPLIED or REJECTED) between our handler call
        // and this write. Re-applying REJECTED here would append a
        // second, duplicate rejected entry for the same reading; simply
        // not touching it is correct either way.
        continue;
      }
      const nextPending = fresh.pending.filter((i) => i.id !== item.id);
      const nextRejected =
        outcome.status === "REJECTED" ? [...fresh.rejected, { ...item, reason: outcome.reason, rejectedAt: Date.now() }] : fresh.rejected;
      const result = persistState(storage, { version: 1, pending: nextPending, rejected: nextRejected });
      if (result.status === "OK") {
        if (outcome.status === "APPLIED") flushed++;
      } else {
        // The write failed — the item is untouched in storage (still
        // pending), so nothing was lost; replaying either outcome again
        // next flush is safe (APPLIED is idempotent, REJECTED is
        // re-derived fresh).
        storageError = true;
      }
    }

    const final = readState(storage);
    return { flushed, remaining: final.pending.length, rejected: final.rejected.length, storageError };
  }

  return { peekQueue, peekRejected, enqueue, dismissRejected, flushQueue };
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;

// The instance every Client Component actually uses.
export const offlineQueue = createOfflineQueue(getDefaultStorage());
