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

const STORAGE_KEY = "bl_offline_queue";

function readStorage(): QueuedAction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
  } catch {
    return [];
  }
}

function writeStorage(queue: QueuedAction[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full or unavailable (private browsing) — the field save
    // itself already failed, so there's nothing better to fall back to.
  }
}

export function enqueue(kind: string, fields: Record<string, string>): QueuedAction {
  const queue = readStorage();
  const item: QueuedAction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, fields, createdAt: Date.now() };
  queue.push(item);
  writeStorage(queue);
  return item;
}

export function peekQueue(): QueuedAction[] {
  return readStorage();
}

export function dequeue(id: string) {
  writeStorage(readStorage().filter((item) => item.id !== id));
}

// Replays every queued item whose kind has a matching handler, dequeuing
// each on success and leaving it queued (for the next flush) on failure —
// so a still-offline or still-failing item doesn't get silently dropped.
export async function flushQueue(handlers: Record<string, (fields: Record<string, string>) => Promise<void>>): Promise<{ flushed: number; remaining: number }> {
  const queue = readStorage();
  let flushed = 0;
  for (const item of queue) {
    const handler = handlers[item.kind];
    if (!handler) continue;
    try {
      await handler(item.fields);
      dequeue(item.id);
      flushed++;
    } catch {
      // Still failing (still offline, or a real error) — leave it queued.
    }
  }
  return { flushed, remaining: readStorage().length };
}
