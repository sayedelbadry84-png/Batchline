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

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

// PL-R8-P1-02, eighth production-lifecycle review: the old check only
// confirmed `pending`/`rejected` were arrays — a parseable but malformed
// item (a missing `id`, a `fields` that isn't a plain string map) could
// still get through, then break rendering or sit forever unreplayable
// (flushQueue has no handler-kind match, forever RETRYABLE-shaped).
// Every item is now validated field-by-field, not just array-shaped.
function isQueuedAction(v: unknown): v is QueuedAction {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.kind === "string" && typeof o.createdAt === "number" && isStringRecord(o.fields);
}

function isRejectedAction(v: unknown): v is RejectedAction {
  if (!isQueuedAction(v)) return false;
  const o = v as unknown as Record<string, unknown>;
  return typeof o.reason === "string" && typeof o.rejectedAt === "number";
}

function isOfflineStateV1(value: unknown): value is OfflineStateV1 {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return o.version === 1 && Array.isArray(o.pending) && o.pending.every(isQueuedAction) && Array.isArray(o.rejected) && o.rejected.every(isRejectedAction);
}

// A typed read outcome, not "corrupt/failure both collapse to an empty
// state" (PL-R8-P1-02) — a storage READ failing (a `getItem` throw) is a
// completely different situation from the stored value being corrupt
// JSON: the former means the EXISTING data might still be there and
// perfectly fine, just unreadable THIS instant (a transient adapter
// fault), so treating it as "empty" and letting a subsequent write
// proceed would silently overwrite and destroy real pending/rejected
// readings that were never actually lost. Every caller below must
// branch on this instead of collapsing it.
type ReadStateResult =
  | { status: "OK"; state: OfflineStateV1 }
  | { status: "STORAGE_UNAVAILABLE"; error?: unknown }
  | { status: "CORRUPT"; raw: string };

function readState(storage: StorageAdapter): ReadStateResult {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    return { status: "STORAGE_UNAVAILABLE", error };
  }
  if (!raw) return { status: "OK", state: emptyState() };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isOfflineStateV1(parsed)) return { status: "OK", state: parsed };
  } catch {
    // fall through — CORRUPT below covers both a JSON parse failure and
    // a validly-parsed value that isn't a real OfflineStateV1 shape.
  }
  return { status: "CORRUPT", raw };
}

function persistState(storage: StorageAdapter, next: OfflineStateV1): PersistResult {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return { status: "OK" };
  } catch (error) {
    // Quota exceeded, storage disabled/blocked, or any other reason
    // setItem can throw — the caller must treat this as "not saved",
    // never as success.
    return { status: "STORAGE_UNAVAILABLE", error };
  }
}

// Recovery for a CORRUPT read: back the raw payload up under a distinct
// key FIRST, and only if that backup genuinely persists does this
// replace STORAGE_KEY with a fresh empty state — never the other way
// around (PL-R8-P1-02's own "corrupt-backup failure must not still
// destroy the primary" finding). If the backup itself can't be written
// (the same failing storage that made the payload unreadable in the
// first place, most likely), the original raw string is left completely
// untouched under STORAGE_KEY and this reports BACKUP_FAILED — callers
// must treat that exactly like STORAGE_UNAVAILABLE: no further write.
function recoverFromCorrupt(storage: StorageAdapter, raw: string): { status: "RECOVERED"; state: OfflineStateV1 } | { status: "BACKUP_FAILED" } {
  const backupKey = `${STORAGE_KEY}_corrupt_backup_${Date.now()}`;
  try {
    storage.setItem(backupKey, raw);
  } catch {
    return { status: "BACKUP_FAILED" };
  }
  const fresh = emptyState();
  const replaced = persistState(storage, fresh);
  warnCorrupt(raw, replaced.status === "OK");
  // Even if replacing the primary key failed, the backup is safely on
  // file and the ORIGINAL raw string is still sitting under STORAGE_KEY
  // untouched (this function never got far enough to fail a write to
  // it before the backup succeeded) — either way it's safe to hand the
  // caller a fresh in-memory state to build this one write on, since
  // the next read will simply go through this same recovery path again.
  return { status: "RECOVERED", state: fresh };
}

let lastCorruptWarning: { raw: string; at: number } | null = null;

// PL-R8-P1-02: "explicit warning/backup policy, not only console.warn" —
// this still logs (useful in real browser devtools), but the actual
// operator-visible signal is OfflineSyncBanner's own corruption banner,
// driven by the readStatus every read-through-recovery caller below
// returns alongside its data.
function warnCorrupt(raw: string, primaryReplaced: boolean) {
  lastCorruptWarning = { raw, at: Date.now() };
  if (typeof console !== "undefined") {
    console.warn(
      `[offlineQueue] stored state was corrupt or an unrecognized shape; backed up under a separate key${primaryReplaced ? " and replaced with a fresh empty state" : " (could not replace the primary key, will recover again next read)"}.`,
      raw,
    );
  }
}

// A read-through-recovery status every peek/mutation below surfaces
// alongside its actual data, so a caller (OfflineSyncBanner, most
// notably) can never render "nothing pending" when reading storage
// genuinely failed, and can show a real recovery warning rather than
// only a devtools console line (PL-R8-P1-02).
export type ReadStatus = "OK" | "STORAGE_UNAVAILABLE" | "RECOVERED_FROM_CORRUPT";

export type EnqueueResult = { status: "OK"; item: QueuedAction } | { status: "STORAGE_UNAVAILABLE" };

// A factory, not a module-level singleton bound to `window.localStorage`
// directly (PL-R7-P1-02) — the default export below is what the app
// actually uses, but tests construct their own instance over a fake
// StorageAdapter (including one that always throws) to exercise failure
// paths deterministically, with no browser/jsdom involved.
export function createOfflineQueue(storage: StorageAdapter | null) {
  // Shared by every mutation below (enqueue/dismissRejected/flushQueue):
  // reads current state, transparently recovering from CORRUPT (backup-
  // then-replace) but NEVER manufacturing a writable empty state out of
  // a genuine STORAGE_UNAVAILABLE read — that's the exact bug PL-R8-P1-02
  // found (a transient getItem failure silently becoming "empty," so the
  // next successful setItem overwrote and destroyed real data).
  function readForMutation(): { status: "OK" | "RECOVERED_FROM_CORRUPT"; state: OfflineStateV1 } | { status: "STORAGE_UNAVAILABLE"; error?: unknown } {
    if (!storage) return { status: "STORAGE_UNAVAILABLE" };
    const read = readState(storage);
    if (read.status === "OK") return { status: "OK", state: read.state };
    if (read.status === "STORAGE_UNAVAILABLE") return read;
    const recovered = recoverFromCorrupt(storage, read.raw);
    if (recovered.status === "BACKUP_FAILED") return { status: "STORAGE_UNAVAILABLE" };
    return { status: "RECOVERED_FROM_CORRUPT", state: recovered.state };
  }

  function peekQueue(): { items: QueuedAction[]; readStatus: ReadStatus } {
    const read = readForMutation();
    return read.status === "STORAGE_UNAVAILABLE" ? { items: [], readStatus: "STORAGE_UNAVAILABLE" } : { items: read.state.pending, readStatus: read.status };
  }

  function peekRejected(): { items: RejectedAction[]; readStatus: ReadStatus } {
    const read = readForMutation();
    return read.status === "STORAGE_UNAVAILABLE" ? { items: [], readStatus: "STORAGE_UNAVAILABLE" } : { items: read.state.rejected, readStatus: read.status };
  }

  function enqueue(kind: string, fields: Record<string, string>): EnqueueResult {
    const read = readForMutation();
    if (read.status === "STORAGE_UNAVAILABLE") return { status: "STORAGE_UNAVAILABLE" };
    const item: QueuedAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, fields, createdAt: Date.now() };
    const result = persistState(storage!, { version: 1, pending: [...read.state.pending, item], rejected: read.state.rejected });
    return result.status === "OK" ? { status: "OK", item } : { status: "STORAGE_UNAVAILABLE" };
  }

  function dismissRejected(id: string): PersistResult {
    const read = readForMutation();
    if (read.status === "STORAGE_UNAVAILABLE") return { status: "STORAGE_UNAVAILABLE" };
    return persistState(storage!, { version: 1, pending: read.state.pending, rejected: read.state.rejected.filter((item) => item.id !== id) });
  }

  // Replays every queued item whose kind has a matching handler.
  // APPLIED and REJECTED each commit their pending→(gone|rejected)
  // transition as ONE persistState call carrying the full next state —
  // never a dequeue followed by a separate rejected-list write. If that
  // single write fails, the item is left exactly as it was in storage
  // (still pending), never partially transitioned.
  async function flushQueue(
    handlers: Record<string, (fields: Record<string, string>) => Promise<ReplayOutcome>>,
  ): Promise<{ flushed: number; remaining: number; rejected: number; readStatus: ReadStatus }> {
    const initial = readForMutation();
    if (initial.status === "STORAGE_UNAVAILABLE") return { flushed: 0, remaining: 0, rejected: 0, readStatus: "STORAGE_UNAVAILABLE" };
    let readStatus: ReadStatus = initial.status;
    let flushed = 0;

    for (const item of initial.state.pending) {
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
      const fresh = readForMutation();
      if (fresh.status === "STORAGE_UNAVAILABLE") {
        readStatus = "STORAGE_UNAVAILABLE";
        continue; // Can't safely read-modify-write right now — leave this item queued for the next flush.
      }
      if (fresh.status === "RECOVERED_FROM_CORRUPT") readStatus = "RECOVERED_FROM_CORRUPT";
      if (!fresh.state.pending.some((i) => i.id === item.id)) {
        // Already gone — a concurrent flushQueue call already resolved
        // this exact item between our handler call and this write.
        // Re-applying REJECTED here would append a duplicate rejected
        // entry for the same reading; simply not touching it is correct
        // either way.
        continue;
      }
      const nextPending = fresh.state.pending.filter((i) => i.id !== item.id);
      const nextRejected =
        outcome.status === "REJECTED" ? [...fresh.state.rejected, { ...item, reason: outcome.reason, rejectedAt: Date.now() }] : fresh.state.rejected;
      const result = persistState(storage!, { version: 1, pending: nextPending, rejected: nextRejected });
      if (result.status === "OK") {
        if (outcome.status === "APPLIED") flushed++;
      } else {
        // The write failed — the item is untouched in storage (still
        // pending), so nothing was lost; replaying either outcome again
        // next flush is safe (APPLIED is idempotent, REJECTED is
        // re-derived fresh).
        readStatus = "STORAGE_UNAVAILABLE";
      }
    }

    const final = readForMutation();
    if (final.status === "STORAGE_UNAVAILABLE") return { flushed, remaining: initial.state.pending.length, rejected: initial.state.rejected.length, readStatus: "STORAGE_UNAVAILABLE" };
    return { flushed, remaining: final.state.pending.length, rejected: final.state.rejected.length, readStatus };
  }

  return { peekQueue, peekRejected, enqueue, dismissRejected, flushQueue };
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>;

// Test-only introspection — the most recent corrupt payload this
// process observed, if any (used by tests to confirm a recovery warning
// actually fired without depending on console output).
export function __lastCorruptWarningForTesting() {
  return lastCorruptWarning;
}

// The instance every Client Component actually uses.
export const offlineQueue = createOfflineQueue(getDefaultStorage());
