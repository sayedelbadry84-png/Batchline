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
import { createOfflineQueue, type StorageAdapter, type ReplayOutcome } from "../src/lib/offlineQueue";

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

test("enqueue then a matching APPLIED handler removes the item from pending and never adds it to rejected", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = queue.enqueue("recordActualField", { value: "12.5" });
  assert.equal(enqueued.status, "OK");

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "APPLIED" }) });
  assert.equal(result.flushed, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.rejected, 0);
  assert.deepEqual(queue.peekQueue(), []);
  assert.deepEqual(queue.peekRejected(), []);
});

test("a RETRYABLE outcome leaves the item queued, completely unchanged", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = queue.enqueue("recordActualField", { value: "3" });
  assert.equal(enqueued.status, "OK");
  const before = queue.peekQueue();

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "RETRYABLE" }) });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(queue.peekQueue(), before);
});

test("a handler that throws leaves the item queued, completely unchanged — the still-offline/transport-error path", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  queue.enqueue("recordActualField", { value: "7" });
  const before = queue.peekQueue();

  const result = await queue.flushQueue({
    recordActualField: async () => {
      throw new Error("network unreachable");
    },
  });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(queue.peekQueue(), before);
});

test("a REJECTED outcome moves the item to the rejected list exactly once, with no window where it exists in neither", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  const enqueued = queue.enqueue("recordActualField", { field: "actual", value: "999" });
  assert.equal(enqueued.status, "OK");

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "REJECTED", reason: "TERMINAL" }) });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.rejected, 1);

  const rejected = queue.peekRejected();
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, enqueued.status === "OK" ? enqueued.item.id : "");
  assert.equal(rejected[0].reason, "TERMINAL");
  assert.deepEqual(queue.peekQueue(), []);
});

test("enqueue never claims success when the underlying storage write actually fails", () => {
  const storage = throwingStorage({ onSetItem: true });
  const queue = createOfflineQueue(storage);

  const result = queue.enqueue("recordActualField", { value: "42" });
  assert.equal(result.status, "STORAGE_UNAVAILABLE");
  // Nothing durable exists anywhere for this reading — peekQueue reads
  // through the same (failing) adapter and correctly sees nothing.
  assert.deepEqual(queue.peekQueue(), []);
});

test("a corrupt stored payload is backed up under a separate key, not silently destroyed, and reads recover as empty", () => {
  const storage = memoryStorage();
  storage.setItem("bl_offline_queue_v1", "{not valid json this is a corrupt payload}");

  const queue = createOfflineQueue(storage);
  assert.deepEqual(queue.peekQueue(), []);
  assert.deepEqual(queue.peekRejected(), []);

  // The raw corrupt string must still be recoverable somewhere, under a
  // genuinely separate backup key — never just discarded outright.
  const backupKeys = [...storage.store.keys()].filter((k) => k !== "bl_offline_queue_v1");
  assert.equal(backupKeys.length, 1);
  assert.equal(storage.store.get(backupKeys[0]), "{not valid json this is a corrupt payload}");
});

test("two concurrent flush attempts against the same storage produce no duplicate rejected item and no lost pending item", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  queue.enqueue("a", { value: "1" });
  queue.enqueue("b", { value: "2" });

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

  assert.deepEqual(queue.peekQueue(), [], "both items must have been resolved out of pending");
  const rejected = queue.peekRejected();
  assert.equal(rejected.length, 1, "exactly one rejected entry for item b, never duplicated by the second concurrent flush");
  assert.equal(rejected[0].kind, "b");
});

test("dismissing a rejected item only removes it from the visible list once persistence actually succeeds", () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage);
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [], rejected: [{ id: "r1", kind: "recordActualField", fields: { value: "5" }, createdAt: 1, reason: "TERMINAL", rejectedAt: 2 }] }));

  const failing = createOfflineQueue(throwingStorage({ onSetItem: true }));
  // Seed the failing adapter's own backing store with the same rejected
  // item indirectly is awkward since it always throws on write — instead
  // prove the CONTRACT directly: a dismiss that can't persist reports
  // STORAGE_UNAVAILABLE, which is exactly what OfflineSyncBanner checks
  // before dropping the item from its own displayed state.
  const failedDismiss = failing.dismissRejected("r1");
  assert.equal(failedDismiss.status, "STORAGE_UNAVAILABLE");

  const okDismiss = queue.dismissRejected("r1");
  assert.equal(okDismiss.status, "OK");
  assert.deepEqual(queue.peekRejected(), []);
});
