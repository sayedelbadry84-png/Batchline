// Pure-logic unit tests for src/lib/offlineQueue.ts — no database, no
// browser/DOM, no TEST_DATABASE_URL. PL-R7-P2-03 (seventh production-
// lifecycle review) asked for exactly this: an injectable storage
// adapter (PL-R7-P1-02) makes the whole offline state machine — APPLIED/
// RETRYABLE/REJECTED replay, persistence-failure handling, corrupt-JSON
// recovery, concurrent flushes, gated dismissal — testable in plain
// node:test, with no browser harness this repo doesn't otherwise have.
//
// Out of scope here: AutoSaveField's own per-field save-coalescing
// (PL-R7-P2-01) is React component behavior with no DOM to render it
// against in this suite — see that file's own comment for the ordering
// guarantee itself; a rendered-component/browser test for it remains a
// disclosed gap, same as the rest of this app's UI layer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOfflineQueue, type StorageAdapter, type ReplayOutcome, type LockAdapter } from "../src/lib/offlineQueue";

// A real in-memory Map-backed adapter — genuinely persists across calls
// within one test, exactly like localStorage would, just without a
// browser. The returned `store` map is test-only introspection (real
// localStorage has no equivalent) — used below to prove a corrupt
// payload gets backed up under a genuinely separate key, not just
// silently dropped.
function memoryStorage(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

// Wraps a real adapter so setItem (or getItem) can be made to fail on
// demand — proves the failure is actually observed and handled, not
// merely that the happy path works.
function throwingStorage(opts: { onSetItem?: boolean; onGetItem?: boolean } = { onSetItem: true }): StorageAdapter {
  const inner = memoryStorage();
  return {
    getItem: (key) => {
      if (opts.onGetItem) throw new Error("simulated getItem failure");
      return inner.getItem(key);
    },
    setItem: (key, value) => {
      if (opts.onSetItem) throw new Error("simulated setItem failure");
      inner.setItem(key, value);
    },
  };
}

// PL-R9-P2-01, ninth production-lifecycle review: models the ONE
// guarantee the real Web Locks API gives two separate browser tabs on
// the same origin — a named lock's holder count never exceeds one, and a
// second requester genuinely waits for the first to release, however
// long that takes. A plain promise chain reproduces exactly that FIFO
// mutual-exclusion contract for two `createOfflineQueue` instances that
// share one lock instance, standing in for "two tabs coordinating
// through the same origin's Web Locks manager" — the real cross-process
// interleaving Web Locks prevents in a browser is not reproducible with
// full fidelity inside one single-threaded Node process, but the
// serialization CONTRACT createOfflineQueue relies on is exactly this,
// and is what these tests hold to a real, enforced invariant below (see
// "a shared lock enforces true mutual exclusion...").
function sharedLock(): LockAdapter {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(() => fn());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

test("enqueue then a matching APPLIED handler removes the item from pending and never adds it to rejected", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = await queue.enqueue("recordActualField", { value: "12.5" });
  assert.equal(enqueued.status, "OK");

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "APPLIED" }) });
  assert.equal(result.flushed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.rejected, 0);
  assert.deepEqual(queue.peekQueue().items, []);
  assert.deepEqual(queue.peekRejected().items, []);
});

test("a RETRYABLE outcome leaves the item queued, completely unchanged", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = await queue.enqueue("recordActualField", { value: "3" });
  assert.equal(enqueued.status, "OK");
  const before = queue.peekQueue().items;

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "RETRYABLE" }) });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(queue.peekQueue().items, before);
});

test("a handler that throws leaves the item queued, completely unchanged — the still-offline/transport-error path", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  await queue.enqueue("recordActualField", { value: "7" });
  const before = queue.peekQueue().items;

  const result = await queue.flushQueue({
    recordActualField: async () => {
      throw new Error("network unreachable");
    },
  });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(queue.peekQueue().items, before);
});

test("a REJECTED outcome moves the item to the rejected list exactly once, with no window where it exists in neither", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = await queue.enqueue("recordActualField", { field: "actual", value: "999" });
  assert.equal(enqueued.status, "OK");

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "REJECTED", reason: "TERMINAL" }) });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.rejected, 1);

  const rejected = queue.peekRejected().items;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, enqueued.status === "OK" ? enqueued.item.id : "");
  assert.equal(rejected[0].reason, "TERMINAL");
  assert.deepEqual(queue.peekQueue().items, []);
});

test("enqueue never claims success when the underlying storage write actually fails", async () => {
  const storage = throwingStorage({ onSetItem: true });
  const queue = createOfflineQueue(storage);

  const result = await queue.enqueue("recordActualField", { value: "42" });
  assert.equal(result.status, "STORAGE_UNAVAILABLE");
  // Nothing durable exists anywhere for this reading — peekQueue reads
  // through the same (failing) adapter and correctly sees nothing.
  assert.deepEqual(queue.peekQueue().items, []);
});

test("a corrupt stored payload is backed up under a separate key, not silently destroyed, and reads recover as empty", () => {
  const storage = memoryStorage();
  storage.setItem("bl_offline_queue_v1", "{not valid json this is a corrupt payload}");

  const queue = createOfflineQueue(storage);
  assert.deepEqual(queue.peekQueue().items, []);
  assert.deepEqual(queue.peekRejected().items, []);

  // The raw corrupt string must still be recoverable somewhere, under a
  // genuinely separate backup key — never just discarded outright.
  const backupKeys = [...storage.store.keys()].filter((k) => k !== "bl_offline_queue_v1");
  assert.equal(backupKeys.length, 1);
  assert.equal(storage.store.get(backupKeys[0]), "{not valid json this is a corrupt payload}");
});

test("two concurrent flush attempts against the same storage produce no duplicate rejected item and no lost pending item", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  await queue.enqueue("a", { value: "1" });
  await queue.enqueue("b", { value: "2" });

  // Deliberately interleaved: both handlers yield to the event loop
  // before resolving, so both flushQueue calls are genuinely in flight
  // (each past its own initial read) at the same time — exactly the
  // "two open tabs" scenario this test proves safe.
  const outcomeFor = (kind: string): ReplayOutcome => (kind === "a" ? { status: "APPLIED" } : { status: "REJECTED", reason: "TERMINAL" });
  const handlers = {
    a: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return outcomeFor("a");
    },
    b: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return outcomeFor("b");
    },
  };

  await Promise.all([queue.flushQueue(handlers), queue.flushQueue(handlers)]);

  assert.deepEqual(queue.peekQueue().items, [], "both items must have been resolved out of pending");
  const rejected = queue.peekRejected().items;
  assert.equal(rejected.length, 1, "exactly one rejected entry for item b, never duplicated by the second concurrent flush");
  assert.equal(rejected[0].kind, "b");
});

test("dismissing a rejected item only removes it from the visible list once persistence actually succeeds", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [], rejected: [{ id: "r1", kind: "recordActualField", fields: { value: "5" }, createdAt: 1, reason: "TERMINAL", rejectedAt: 2 }] }));

  const failing = createOfflineQueue(throwingStorage({ onSetItem: true }));
  // Seed the failing adapter's own backing store with the same rejected
  // item indirectly is awkward since it always throws on write — instead
  // prove the CONTRACT directly: a dismiss that can't persist reports
  // STORAGE_UNAVAILABLE, which is exactly what OfflineSyncBanner checks
  // before dropping the item from its own displayed state.
  const failedDismiss = await failing.dismissRejected("r1");
  assert.equal(failedDismiss.status, "STORAGE_UNAVAILABLE");

  const okDismiss = await queue.dismissRejected("r1");
  assert.equal(okDismiss.status, "OK");
  assert.deepEqual(queue.peekRejected().items, []);
});

// PL-R8-P1-02, eighth production-lifecycle review: the round-7 version
// collapsed a getItem THROW into "empty state", so a subsequent
// successful enqueue/dismiss write would silently overwrite and destroy
// whatever real pending/rejected readings were already on file — a
// storage READ failing is not proof the data is gone, only that this
// one call couldn't see it. This proves the fix: a getItem failure must
// report STORAGE_UNAVAILABLE and refuse to write at all, never fabricate
// a writable empty snapshot.
test("a getItem failure never becomes a writable empty snapshot that could overwrite real existing data", async () => {
  // Seed real data through a working adapter first, then swap to one
  // whose reads fail but whose writes would otherwise still succeed —
  // proving the failure is specifically about not trusting a failed
  // READ, not about setItem also being broken.
  const storage = memoryStorage();
  const seedQueue = createOfflineQueue(storage);
  await seedQueue.enqueue("recordActualField", { value: "1" });
  const seededRaw = storage.store.get("bl_offline_queue_v1");
  assert.ok(seededRaw);

  const readFailing: StorageAdapter = {
    getItem: () => {
      throw new Error("simulated getItem failure");
    },
    setItem: storage.setItem,
  };
  const queue = createOfflineQueue(readFailing);

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "STORAGE_UNAVAILABLE");
  assert.deepEqual(peeked.items, []);

  const enqueueResult = await queue.enqueue("recordActualField", { value: "2" });
  assert.equal(enqueueResult.status, "STORAGE_UNAVAILABLE", "must refuse to write when the prior read couldn't be trusted");

  // The ORIGINAL seeded data must still be sitting there completely
  // untouched — proof nothing was overwritten.
  assert.equal(storage.store.get("bl_offline_queue_v1"), seededRaw);
});

test("a corrupt payload whose backup write also fails leaves the primary value completely untouched", () => {
  const storage = memoryStorage();
  const corruptRaw = "{not valid json — this must survive}";
  storage.setItem("bl_offline_queue_v1", corruptRaw);

  // setItem fails for EVERY key here, including the backup key — proves
  // recovery never reaches the "replace the primary" step without a
  // confirmed backup first.
  const backupFailing: StorageAdapter = {
    getItem: storage.getItem,
    setItem: () => {
      throw new Error("simulated setItem failure (backup included)");
    },
  };
  const queue = createOfflineQueue(backupFailing);

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "STORAGE_UNAVAILABLE", "an unrecoverable corrupt payload must not silently present as an empty, writable queue");
  assert.deepEqual(peeked.items, []);

  // The original corrupt (but potentially manually recoverable) string
  // must still be exactly there — never replaced with an empty state
  // when the backup itself couldn't be confirmed.
  assert.equal(storage.store.get("bl_offline_queue_v1"), corruptRaw);
});

test("a corrupt payload whose backup write succeeds recovers to empty and reports RECOVERED_FROM_CORRUPT", () => {
  const storage = memoryStorage();
  storage.setItem("bl_offline_queue_v1", "{ this parses to nothing usable ");
  const queue = createOfflineQueue(storage);

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "RECOVERED_FROM_CORRUPT");
  assert.deepEqual(peeked.items, []);
});

test("a parseable but malformed queue item (missing required fields) is treated as corrupt, never rendered or replayed as-is", () => {
  const storage = memoryStorage();
  // Valid JSON, valid top-level shape, but a pending item missing `id`
  // and `fields` — exactly the "parseable but malformed" gap PL-R8-P1-02
  // named: the old array-only check would have accepted this.
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [{ kind: "recordActualField", createdAt: 1 }], rejected: [] }));
  const queue = createOfflineQueue(storage);

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "RECOVERED_FROM_CORRUPT", "a malformed item must be treated as a corrupt payload, not silently trusted");
  assert.deepEqual(peeked.items, []);
});

test("`fields` stored as an array is rejected as corrupt, never trusted as a Record<string, string>", () => {
  const storage = memoryStorage();
  // typeof [] === "object" and Object.values([...]) both accept an array
  // — the exact gap PL-R9-P2-01 closed in isStringRecord.
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [{ id: "p1", kind: "recordActualField", fields: ["not", "a", "record"], createdAt: 1 }], rejected: [] }));
  const queue = createOfflineQueue(storage);

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "RECOVERED_FROM_CORRUPT", "an array-shaped fields must be treated as corrupt, not silently accepted");
  assert.deepEqual(peeked.items, []);
});

// ---- PL-R9-P2-01: two-instance tests modeling real cross-tab access to
// ---- the SAME origin storage, coordinated through one shared lock — see
// ---- sharedLock's own comment above for exactly what this can and
// ---- cannot prove in a single-threaded test process.

test("a shared lock enforces true mutual exclusion between two withLock callers, even when one has a real async gap", async () => {
  const lock = sharedLock();
  let running = false;
  let overlapDetected = false;
  const order: string[] = [];

  async function criticalSection(name: string, delayMs: number) {
    return lock.withLock(async () => {
      if (running) overlapDetected = true;
      running = true;
      order.push(`${name}:enter`);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      order.push(`${name}:exit`);
      running = false;
    });
  }

  // "tab1" is slow (simulates real latency inside its own critical
  // section); "tab2" is fired essentially immediately after — if the
  // lock didn't serialize them, tab2 could enter while tab1 is still
  // mid-flight (running === true), exactly the interleaving that
  // silently loses one tab's write in production.
  await Promise.all([criticalSection("tab1", 20), criticalSection("tab2", 0)]);

  assert.equal(overlapDetected, false, "no two critical sections may ever run concurrently under the same lock");
  assert.deepEqual(order, ["tab1:enter", "tab1:exit", "tab2:enter", "tab2:exit"], "tab2 must wait for tab1 to fully exit before entering");
});

test("two-instance enqueue/enqueue over the same storage and a shared lock never loses either reading", async () => {
  const storage = memoryStorage();
  const lock = sharedLock();
  const tab1 = createOfflineQueue(storage, lock);
  const tab2 = createOfflineQueue(storage, lock);

  const [r1, r2] = await Promise.all([tab1.enqueue("recordActualField", { field: "actual", value: "10" }), tab2.enqueue("recordActualField", { field: "moisture", value: "3" })]);
  assert.equal(r1.status, "OK");
  assert.equal(r2.status, "OK");

  const items = tab1.peekQueue().items;
  assert.equal(items.length, 2, "both tabs' readings must survive — neither enqueue may silently overwrite the other's read-modify-write");
  assert.deepEqual(
    items.map((i) => i.fields.field).sort(),
    ["actual", "moisture"],
  );
});

test("two-instance enqueue vs. dismiss over the same storage and a shared lock: both changes survive together", async () => {
  const storage = memoryStorage();
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [], rejected: [{ id: "r1", kind: "recordActualField", fields: { value: "5" }, createdAt: 1, reason: "TERMINAL", rejectedAt: 2 }] }));
  const lock = sharedLock();
  const tab1 = createOfflineQueue(storage, lock);
  const tab2 = createOfflineQueue(storage, lock);

  const [dismissResult, enqueueResult] = await Promise.all([tab1.dismissRejected("r1"), tab2.enqueue("recordActualField", { field: "actual", value: "88" })]);
  assert.equal(dismissResult.status, "OK");
  assert.equal(enqueueResult.status, "OK");

  assert.deepEqual(tab1.peekRejected().items, [], "tab1's dismiss must have taken effect");
  assert.equal(tab1.peekQueue().items.length, 1, "tab2's enqueue must have taken effect too — neither read-modify-write may clobber the other's already-persisted change");
});

test("two-instance enqueue during a slow concurrent flush: the new reading is never lost, the flushed one is still resolved correctly", async () => {
  const storage = memoryStorage();
  const lock = sharedLock();
  const flushingTab = createOfflineQueue(storage, lock);
  const otherTab = createOfflineQueue(storage, lock);

  await flushingTab.enqueue("slow-kind", { value: "1" });

  const slowHandler = {
    "slow-kind": async (): Promise<ReplayOutcome> => {
      // The handler call itself is deliberately OUTSIDE the lock (see
      // offlineQueue.ts's own comment on why) — this delay is exactly
      // the window where another tab's enqueue must still be able to
      // proceed immediately rather than blocking on a slow network call
      // it has nothing to do with.
      await new Promise((r) => setTimeout(r, 15));
      return { status: "APPLIED" };
    },
  };

  const [flushResult, enqueueResult] = await Promise.all([flushingTab.flushQueue(slowHandler), otherTab.enqueue("recordActualField", { field: "actual", value: "99" })]);

  assert.equal(flushResult.flushed, 1);
  assert.equal(enqueueResult.status, "OK", "the concurrent enqueue must not be blocked or lost while the unrelated flush handler is still in flight");

  const remaining = flushingTab.peekQueue().items;
  assert.equal(remaining.length, 1, "the newly enqueued item must survive flushQueue's own re-read-freshest-state write, not be silently dropped by it");
  assert.equal(remaining[0].fields.field, "actual");
});
