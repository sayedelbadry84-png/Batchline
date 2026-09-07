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

const STORAGE_KEY = "bl_offline_queue";
const REJECTED_STORAGE_KEY = "bl_offline_rejected";

function readList<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, list: T[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage full or unavailable (private browsing) — the field save
    // itself already failed, so there's nothing better to fall back to.
  }
}

export function enqueue(kind: string, fields: Record<string, string>): QueuedAction {
  const queue = readList<QueuedAction>(STORAGE_KEY);
  const item: QueuedAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, fields, createdAt: Date.now() };
  queue.push(item);
  writeList(STORAGE_KEY, queue);
  return item;
}

export function peekQueue(): QueuedAction[] {
  return readList<QueuedAction>(STORAGE_KEY);
}

export function dequeue(id: string) {
  writeList(STORAGE_KEY, readList<QueuedAction>(STORAGE_KEY).filter((item) => item.id !== id));
}

// The dead-letter list a REJECTED replay moves into — never auto-
// retried, never silently cleared. dismissRejected is a deliberate
// supervisor action (they've reconciled the value some other way), not
// something the sync pipeline itself ever calls.
export function peekRejected(): RejectedAction[] {
  return readList<RejectedAction>(REJECTED_STORAGE_KEY);
}

export function dismissRejected(id: string) {
  writeList(REJECTED_STORAGE_KEY, readList<RejectedAction>(REJECTED_STORAGE_KEY).filter((item) => item.id !== id));
}

// Replays every queued item whose kind has a matching handler. APPLIED
// dequeues and counts as flushed; REJECTED dequeues into the rejected
// list (still removed from the active queue, but never silently lost);
// RETRYABLE — or the handler throwing outright, a real transient
// network/transport failure — leaves the item queued for the next flush.
export async function flushQueue(handlers: Record<string, (fields: Record<string, string>) => Promise<ReplayOutcome>>): Promise<{ flushed: number; remaining: number; rejected: number }> {
  const queue = readList<QueuedAction>(STORAGE_KEY);
  let flushed = 0;
  for (const item of queue) {
    const handler = handlers[item.kind];
    if (!handler) continue;
    let outcome: ReplayOutcome;
    try {
      outcome = await handler(item.fields);
    } catch {
      continue; // Still offline, or a real transport error — leave it queued.
    }
    if (outcome.status === "APPLIED") {
      dequeue(item.id);
      flushed++;
    } else if (outcome.status === "REJECTED") {
      dequeue(item.id);
      const rejected = readList<RejectedAction>(REJECTED_STORAGE_KEY);
      rejected.push({ ...item, reason: outcome.reason, rejectedAt: Date.now() });
      writeList(REJECTED_STORAGE_KEY, rejected);
    }
    // RETRYABLE: leave it queued, exactly as-is, for the next flush.
  }
  return { flushed, remaining: readList<QueuedAction>(STORAGE_KEY).length, rejected: readList<RejectedAction>(REJECTED_STORAGE_KEY).length };
}
