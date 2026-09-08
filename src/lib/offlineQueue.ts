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

// PL-R9-P2-01, ninth production-lifecycle review: enqueue/dismissRejected
// (and flushQueue's own per-item write) are each a plain getItem→modify→
// setItem sequence with no cross-tab coordination — two browser tabs can
// each read the same starting state, append/modify their own change in
// memory, and whichever setItem runs last silently erases the other
// tab's change. Server-side versioning (PL-R9-P1-03) cannot help here:
// the losing tab's reading never reaches the server at all, so there is
// nothing for the server to reject. A named Web Lock serializes every
// mutation across every tab/frame on this origin — the browser itself
// queues a second `request` call for the same name until the first
// resolves, even across separate tabs, which a JS-level mutex confined
// to one tab's own heap cannot do.
export type LockAdapter = { withLock<T>(fn: () => Promise<T>): Promise<T> };

// Returns null on a browser (or test runner) without the Web Locks API.
// PL-R9-P2-01's original fallback here ran mutations unserialized in
// that case, reasoning "no worse than before this fix" — Round 10 named
// that a real, still-lossy fallback (a client that can't serialize
// simply reintroduces the exact cross-tab race this whole mechanism
// exists to close). createOfflineQueue's own mutating operations now
// fail CLOSED instead whenever this returns null — see that factory's
// own comment. Web Locks is already supported by every browser this app
// otherwise targets (evergreen Chrome/Edge/Firefox/Safari); a null here
// in production is the genuinely exceptional case, not the common one.
function getDefaultLock(): LockAdapter | null {
  if (typeof navigator === "undefined" || !("locks" in navigator) || !navigator.locks) return null;
  const locks = navigator.locks;
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      // lib.dom.d.ts's LockGrantedCallback<T> types the callback as
      // returning T directly, not Promise<T> — losing the real Web Locks
      // spec behavior (the lock isn't released, and request()'s own
      // promise doesn't settle, until a callback-returned promise
      // itself settles). The cast reflects that real runtime contract,
      // not a type-system bypass of it.
      return locks.request("bl-offline-queue", () => fn()) as unknown as Promise<T>;
    },
  };
}

const STORAGE_KEY = "bl_offline_queue_v1";

type OfflineStateV1 = { version: 1; pending: QueuedAction[]; rejected: RejectedAction[] };

function emptyState(): OfflineStateV1 {
  return { version: 1, pending: [], rejected: [] };
}

// PL-R9-P2-01, ninth production-lifecycle review: `typeof [] === "object"`
// and `Object.values([...])` both happily accept an array, so a stored
// `fields` that was somehow an array of strings (a hand-edited payload, a
// future bug elsewhere) passed this check and was trusted as a
// Record<string, string> — every consumer that does `fields.field` or
// `fields.value` would then silently read `undefined` instead of being
// caught here as corrupt.
function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
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

// PL-R10-P1-03, tenth production-lifecycle review: a real deterministic
// failure sequence found in the offline queue — two offline edits to the
// SAME field (kind + identity fields identical, only the value differs)
// used to enqueue as two SEPARATE items, both carrying the version the
// field had when it first went offline. Replay applied the OLDER value
// first (advancing the server's version), then rejected the genuinely
// LATEST value as STALE_READING — the operator's real final reading was
// silently discarded while a stale one won.
//
// This identifies "the same logical field" generically, without
// offlineQueue.ts hardcoding any domain-specific field names: `value`
// (the one field a caller's own mutable reading lives under — see
// mutableField below) and `expectedVersion` (the optimistic-concurrency
// token, itself derived from a read, not part of the field's own
// identity) are excluded; every remaining field (kind plus whatever
// identifies WHICH row/field this is — ticket/component/field today) is
// sorted for a stable key. Two enqueue calls that produce the same key
// are, by construction, two beliefs about the exact same protected
// value.
const MUTABLE_FIELD_NAMES = new Set(["expectedVersion"]);

export function logicalKey(kind: string, fields: Record<string, string>, mutableField = "value"): string {
  const identity = Object.entries(fields)
    .filter(([k]) => k !== mutableField && !MUTABLE_FIELD_NAMES.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${kind}|${identity}`;
}

// PL-R10-P1-03: the other half of the fix — once a queued item's replay
// actually reaches the server and returns a fresh version, the still-
// mounted AutoSaveField instance that originally enqueued it must learn
// that version before its NEXT save (online or offline), or that next
// save will carry the same stale pre-offline version and be refused for
// no real reason. OfflineSyncBanner (a sibling component with no direct
// reference to any specific AutoSaveField instance) and AutoSaveField
// itself have no shared parent state to thread this through — this is a
// minimal, module-scoped pub/sub keyed by the exact same logicalKey both
// sides can independently compute from data they already have (their own
// hiddenFields/kind on one side, the queued item's own kind/fields on the
// other), not a general event bus.
type ReplaySuccessListener = (version: number) => void;
const replaySuccessListeners = new Map<string, Set<ReplaySuccessListener>>();

export function onReplaySuccess(key: string, listener: ReplaySuccessListener): () => void {
  let set = replaySuccessListeners.get(key);
  if (!set) {
    set = new Set();
    replaySuccessListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) replaySuccessListeners.delete(key);
  };
}

export function emitReplaySuccess(key: string, version: number): void {
  replaySuccessListeners.get(key)?.forEach((listener) => listener(version));
}

// A factory, not a module-level singleton bound to `window.localStorage`
// directly (PL-R7-P1-02) — the default export below is what the app
// actually uses, but tests construct their own instance over a fake
// StorageAdapter (including one that always throws) to exercise failure
// paths deterministically, with no browser/jsdom involved.
export function createOfflineQueue(storage: StorageAdapter | null, lock: LockAdapter | null = getDefaultLock()) {
  // PL-R10-P2-02, tenth production-lifecycle review: the old fallback
  // here ran every mutation unserialized when no lock was available,
  // reasoning that this was "no worse than before" Web Locks existed —
  // but "still loses an item on an unsupported/disabled client" is not a
  // safe fallback, it's just the same known-lossy cross-tab race Round 9
  // set out to close, silently reintroduced for exactly the clients that
  // can't defend against it. Every mutating operation below now checks
  // `lock` itself (via requireLock, right below) and fails CLOSED with no
  // lock — a mutation reports STORAGE_UNAVAILABLE rather than proceeding
  // unserialized, surfacing through the SAME storage-error UI a
  // genuinely broken localStorage already does, so the operator is told
  // to write the reading down rather than shown a false "queued" status
  // masking a real cross-tab loss risk. Reads (peekQueue/peekRejected)
  // are unaffected — they don't mutate state, so they carry no such risk
  // and stay available either way. Only ever called once a caller has
  // already checked `lock !== null` itself — kept as its own small
  // helper purely so the mutating call sites below all share the
  // identical `lock.withLock(async () => fn())` wrapping rather than
  // repeating it.
  function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return lock!.withLock(async () => fn());
  }

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

  function enqueue(kind: string, fields: Record<string, string>, mutableField = "value"): Promise<EnqueueResult> {
    // PL-R10-P2-02: fail closed, never proceed unserialized — see this
    // factory's own top comment.
    if (!lock) return Promise.resolve({ status: "STORAGE_UNAVAILABLE" });
    return withLock(() => {
      const read = readForMutation();
      if (read.status === "STORAGE_UNAVAILABLE") return { status: "STORAGE_UNAVAILABLE" };

      // PL-R10-P1-03: a second offline edit to the SAME field coalesces
      // onto the item already queued for it, rather than enqueuing a
      // second, independent stale-version write — see logicalKey's own
      // comment for the full failure sequence this closes. Only the
      // mutable value itself is replaced; `expectedVersion` (and every
      // other field) is deliberately kept from the EARLIER item — it is
      // still the correct base to replay against, since nothing else can
      // have touched the server for this field while genuinely offline.
      const key = logicalKey(kind, fields, mutableField);
      const existingIndex = read.state.pending.findIndex((i) => logicalKey(i.kind, i.fields, mutableField) === key);
      if (existingIndex !== -1) {
        const existing = read.state.pending[existingIndex];
        const merged: QueuedAction = { ...existing, fields: { ...existing.fields, [mutableField]: fields[mutableField] } };
        const nextPending = [...read.state.pending];
        nextPending[existingIndex] = merged;
        const result = persistState(storage!, { version: 1, pending: nextPending, rejected: read.state.rejected });
        return result.status === "OK" ? { status: "OK", item: merged } : { status: "STORAGE_UNAVAILABLE" };
      }

      const item: QueuedAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, fields, createdAt: Date.now() };
      const result = persistState(storage!, { version: 1, pending: [...read.state.pending, item], rejected: read.state.rejected });
      return result.status === "OK" ? { status: "OK", item } : { status: "STORAGE_UNAVAILABLE" };
    });
  }

  function dismissRejected(id: string): Promise<PersistResult> {
    // PL-R10-P2-02: fail closed, never proceed unserialized.
    if (!lock) return Promise.resolve({ status: "STORAGE_UNAVAILABLE" });
    return withLock(() => {
      const read = readForMutation();
      if (read.status === "STORAGE_UNAVAILABLE") return { status: "STORAGE_UNAVAILABLE" };
      return persistState(storage!, { version: 1, pending: read.state.pending, rejected: read.state.rejected.filter((item) => item.id !== id) });
    });
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

      // The read-modify-write below runs under the SAME named lock
      // enqueue/dismissRejected use (PL-R9-P2-01) — without it, this
      // re-read-then-persist step is exactly the same unserialized
      // getItem→setItem race as a plain enqueue, just with flushQueue as
      // the writer instead. The handler call above stays OUTSIDE the
      // lock deliberately: it can be a slow network round-trip, and
      // holding a cross-tab lock across that would block every other
      // tab's own enqueue/dismiss/flush for as long as this one request
      // takes.
      //
      // PL-R10-P2-02: fails closed with no lock, same as enqueue/
      // dismissRejected — a handler that already succeeded server-side
      // stays queued rather than risk an unserialized write here; it
      // will simply be re-applied (idempotently) on the next flush once
      // a lock is available again.
      if (!lock) {
        readStatus = "STORAGE_UNAVAILABLE";
        continue;
      }
      const writeOutcome = await withLock(() => {
        // Re-read the FRESHEST state right before this one item's write,
        // not the snapshot flushQueue started with — two concurrent
        // flushQueue calls (e.g. two open tabs on the same ticket) can
        // otherwise each work from a stale snapshot and clobber each
        // other's already-persisted removals.
        const fresh = readForMutation();
        if (fresh.status === "STORAGE_UNAVAILABLE") return { status: "STORAGE_UNAVAILABLE" as const };
        if (!fresh.state.pending.some((i) => i.id === item.id)) {
          // Already gone — a concurrent flushQueue call already resolved
          // this exact item between our handler call and this write.
          // Re-applying REJECTED here would append a duplicate rejected
          // entry for the same reading; simply not touching it is
          // correct either way.
          return { status: "ALREADY_RESOLVED" as const };
        }
        const nextPending = fresh.state.pending.filter((i) => i.id !== item.id);
        const nextRejected =
          outcome.status === "REJECTED" ? [...fresh.state.rejected, { ...item, reason: outcome.reason, rejectedAt: Date.now() }] : fresh.state.rejected;
        const persisted = persistState(storage!, { version: 1, pending: nextPending, rejected: nextRejected });
        return persisted.status === "OK"
          ? { status: "OK" as const, readStatus: fresh.status === "RECOVERED_FROM_CORRUPT" ? ("RECOVERED_FROM_CORRUPT" as const) : undefined }
          : { status: "STORAGE_UNAVAILABLE" as const };
      });

      if (writeOutcome.status === "OK") {
        if (writeOutcome.readStatus === "RECOVERED_FROM_CORRUPT") readStatus = "RECOVERED_FROM_CORRUPT";
        if (outcome.status === "APPLIED") flushed++;
      } else if (writeOutcome.status === "STORAGE_UNAVAILABLE") {
        // The write failed (or couldn't safely read first) — the item is
        // untouched in storage (still pending), so nothing was lost;
        // replaying either outcome again next flush is safe (APPLIED is
        // idempotent, REJECTED is re-derived fresh).
        readStatus = "STORAGE_UNAVAILABLE";
      }
      // ALREADY_RESOLVED: nothing to update — a concurrent flush already
      // persisted this item's outcome.
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
