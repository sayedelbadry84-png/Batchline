// Pure-logic unit tests for src/lib/offlineQueue.ts — no database, no
// browser/DOM, no TEST_DATABASE_URL. PL-R7-P2-03 (seventh production-
// lifecycle review) asked for exactly this: an injectable storage
// adapter (PL-R7-P1-02) makes the whole offline state machine — APPLIED/
// RETRYABLE/REJECTED replay, persistence-failure handling, corrupt-JSON
// recovery, concurrent flushes, gated dismissal — testable in plain
// node:test, with no browser harness this repo doesn't otherwise have.
//
// AutoSaveField's own per-field save-coalescing (PL-R7-P2-01, online) and
// offline same-field enqueue coalescing (PL-R10-P1-03) are both React
// component / real-DOM behavior — see tests/AutoSaveField.test.tsx for the
// rendered coverage of both. This file stays scoped to offlineQueue.ts's
// own pure logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOfflineQueue, logicalKey, onReplaySuccess, emitReplaySuccess, type StorageAdapter, type ReplayOutcome, type LockAdapter } from "../src/lib/offlineQueue";
// PL-R15-P2-01: the production result-to-outcome mapping itself, so the
// replay tests below drive the real decision logic instead of a copy of
// it written into a fake handler.
import { toReplayOutcome, sameFiniteReading } from "../src/lib/recordActualFieldReplay";
import type { RecordActualFieldResult } from "../src/app/(app)/production/actions";

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
  const queue = createOfflineQueue(storage, sharedLock());
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
  const queue = createOfflineQueue(storage, sharedLock());
  const enqueued = await queue.enqueue("recordActualField", { value: "3" });
  assert.equal(enqueued.status, "OK");
  const before = queue.peekQueue().items;

  const result = await queue.flushQueue({ recordActualField: async () => ({ status: "RETRYABLE" }) });
  assert.equal(result.flushed, 0);
  assert.equal(result.remaining, 1);
  assert.deepEqual(queue.peekQueue().items, before);
});

// ---- PL-R10-P1-03, tenth production-lifecycle review: a real
// ---- deterministic failure the round found — two offline edits to the
// ---- SAME field enqueued as two SEPARATE items, both carrying the
// ---- version the field had when it first went offline. Replay applied
// ---- the OLDER value first (advancing the server version), then
// ---- rejected the genuinely latest value as STALE_READING. These prove
// ---- the fix at the offlineQueue.ts layer directly.

test("a second offline enqueue for the same logical field coalesces onto the first item, keeping the earliest expectedVersion but the latest value", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, sharedLock());

  const first = await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "10", expectedVersion: "0" });
  assert.equal(first.status, "OK");
  const second = await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "20", expectedVersion: "0" });
  assert.equal(second.status, "OK");

  const items = queue.peekQueue().items;
  assert.equal(items.length, 1, "the second enqueue must coalesce onto the first item, not create a second, independently-replayable one");
  assert.equal(items[0].fields.value, "20", "the LATEST value must be what's actually queued for replay");
  assert.equal(items[0].fields.expectedVersion, "0", "expectedVersion must stay the original base — still correct, since nothing else could have touched the server while genuinely offline");
  assert.equal(items[0].id, first.status === "OK" ? first.item.id : "", "the coalesced item must keep the FIRST item's own identity, not become a new queue entry");
});

test("offline edits to two DIFFERENT fields on the same component enqueue as two separate items, never coalesced together", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, sharedLock());
  await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "10", expectedVersion: "0" });
  await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "moisture", value: "3", expectedVersion: "0" });
  const items = queue.peekQueue().items;
  assert.equal(items.length, 2, "different fields must never coalesce into one — they carry independent server versions (actualVersion/moistureVersion)");
});

test("logicalKey ignores the mutable value and expectedVersion fields, but is sensitive to every identity field", () => {
  const base = logicalKey("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "10", expectedVersion: "0" });
  const sameIdentityDifferentValue = logicalKey("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "999", expectedVersion: "5" });
  assert.equal(base, sameIdentityDifferentValue, "differing only in value/expectedVersion must produce the SAME key");

  assert.notEqual(base, logicalKey("recordActualField", { batchTicketId: "t1", componentId: "c2", field: "actual", value: "10", expectedVersion: "0" }), "a different componentId must change the key");
  assert.notEqual(base, logicalKey("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "moisture", value: "10", expectedVersion: "0" }), "a different field must change the key");
  assert.notEqual(base, logicalKey("otherKind", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "10", expectedVersion: "0" }), "a different kind must change the key");
});

test("emitReplaySuccess calls only listeners subscribed to the matching key, carrying the emitted version, and never fires again after unsubscribe", () => {
  const received: number[] = [];
  const unsubscribe = onReplaySuccess("kind|a=1", (version) => received.push(version));
  emitReplaySuccess("kind|a=1", 3);
  emitReplaySuccess("kind|a=2", 99); // a different key — must not fire this listener
  assert.deepEqual(received, [3]);

  unsubscribe();
  emitReplaySuccess("kind|a=1", 4);
  assert.deepEqual(received, [3], "a listener must never fire again after unsubscribing");
});

test("a handler that throws leaves the item queued, completely unchanged — the still-offline/transport-error path", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, sharedLock());
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
  const queue = createOfflineQueue(storage, sharedLock());
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
  const queue = createOfflineQueue(storage, sharedLock());

  const result = await queue.enqueue("recordActualField", { value: "42" });
  assert.equal(result.status, "STORAGE_UNAVAILABLE");
  // Nothing durable exists anywhere for this reading — peekQueue reads
  // through the same (failing) adapter and correctly sees nothing.
  assert.deepEqual(queue.peekQueue().items, []);
});

test("a corrupt stored payload is backed up under a separate key, not silently destroyed, and reads recover as empty", () => {
  const storage = memoryStorage();
  storage.setItem("bl_offline_queue_v1", "{not valid json this is a corrupt payload}");

  const queue = createOfflineQueue(storage, sharedLock());
  assert.deepEqual(queue.peekQueue().items, []);
  assert.deepEqual(queue.peekRejected().items, []);

  // The raw corrupt string must still be recoverable somewhere, under a
  // genuinely separate backup key — never just discarded outright.
  const backupKeys = [...storage.store.keys()].filter((k) => k !== "bl_offline_queue_v1");
  assert.equal(backupKeys.length, 1);
  assert.equal(storage.store.get(backupKeys[0]), "{not valid json this is a corrupt payload}");
});

// ---- PL-R12-P1-01, twelfth production-lifecycle review: `id` alone was
// ---- not a safe settlement key. enqueue coalesces a newer reading onto
// ---- the SAME id, while flushQueue necessarily sends outside the lock,
// ---- so an older in-flight replay could settle by id and DELETE a newer
// ---- value that was never sent. These are the three deterministic
// ---- proofs the review asked for, in its own order.

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a newer value coalesced during an in-flight replay is never deleted by the older replay's settlement — it inherits the returned server version and applies next", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, sharedLock());
  await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "10", expectedVersion: "0" });

  const firstSendStarted = deferred();
  const releaseFirstSend = deferred();
  const sent: { value: string; expectedVersion: string }[] = [];

  const flushPromise = queue.flushQueue({
    recordActualField: async (fields) => {
      sent.push({ value: fields.value, expectedVersion: fields.expectedVersion });
      firstSendStarted.resolve();
      await releaseFirstSend.promise;
      return { status: "APPLIED", version: 1 };
    },
  });

  // A newer reading arrives while value 10 is genuinely still in flight.
  await firstSendStarted.promise;
  assert.equal((await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "20", expectedVersion: "0" })).status, "OK");
  releaseFirstSend.resolve();
  await flushPromise;

  const pending = queue.peekQueue().items;
  assert.equal(pending.length, 1, "the newer value must still be queued — the older replay's settlement must never delete it");
  assert.equal(pending[0].fields.value, "20");
  assert.equal(pending[0].fields.expectedVersion, "1", "the successor must inherit the authoritative version the applied replay returned");
  assert.deepEqual(queue.peekRejected().items, [], "nothing may be rejected here — no conflict actually happened");

  // And it applies on the next flush, against exactly that inherited version.
  const second = await queue.flushQueue({
    recordActualField: async (fields) => {
      sent.push({ value: fields.value, expectedVersion: fields.expectedVersion });
      return { status: "APPLIED", version: 2 };
    },
  });
  assert.equal(second.flushed, 1);
  assert.deepEqual(sent, [
    { value: "10", expectedVersion: "0" },
    { value: "20", expectedVersion: "1" },
  ]);
  assert.deepEqual(queue.peekQueue().items, [], "the successor must now be fully settled");
});

test("two queue instances over one stored snapshot produce exactly one effective write, no duplicate effect, and no false rejection", async () => {
  const storage = memoryStorage();
  const lock = sharedLock();
  const tabA = createOfflineQueue(storage, lock);
  const tabB = createOfflineQueue(storage, lock);
  await tabA.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "42", expectedVersion: "0" });

  // A version-aware fake server — applies only when expectedVersion
  // matches, exactly like recordActualField's own CAS, so a duplicate
  // send of the same snapshot would come back STALE_READING and (before
  // the lease claim) be recorded as a false rejected reading.
  let serverVersion = 0;
  let serverValue: string | null = null;
  const applied: string[] = [];
  const handler = async (fields: Record<string, string>): Promise<ReplayOutcome> => {
    await new Promise((r) => setTimeout(r, 5));
    if (Number(fields.expectedVersion) !== serverVersion) return { status: "REJECTED", reason: "STALE_READING" };
    serverVersion += 1;
    serverValue = fields.value;
    applied.push(fields.value);
    return { status: "APPLIED", version: serverVersion };
  };

  await Promise.all([tabA.flushQueue({ recordActualField: handler }), tabB.flushQueue({ recordActualField: handler })]);

  assert.deepEqual(applied, ["42"], "exactly one effective server write — the second tab must never send the same claimed snapshot");
  assert.equal(serverValue, "42");
  assert.deepEqual(tabA.peekRejected().items, [], "no false rejection may be recorded for a reading that actually applied");
  assert.deepEqual(tabA.peekQueue().items, [], "the reading must be settled exactly once");
});

test("an APPLIED result whose settlement cannot be stored is reconciled on the next flush, never re-sent into a false stale rejection", async () => {
  const inner = memoryStorage();
  let writes = 0;
  let failWriteNumber: number | null = null;
  const storage: StorageAdapter = {
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      writes += 1;
      if (writes === failWriteNumber) throw new Error("simulated quota failure");
      inner.setItem(key, value);
    },
  };
  const queue = createOfflineQueue(storage, sharedLock());
  await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "7", expectedVersion: "0" }); // write 1

  let serverVersion = 0;
  const sends: string[] = [];
  const handler = async (fields: Record<string, string>): Promise<ReplayOutcome> => {
    sends.push(fields.value);
    if (Number(fields.expectedVersion) !== serverVersion) return { status: "REJECTED", reason: "STALE_READING" };
    serverVersion += 1;
    return { status: "APPLIED", version: serverVersion };
  };

  // Write 2 is the replay claim; write 3 is the settlement — fail only
  // the settlement, so the server has genuinely accepted the value but
  // this client could not record that fact.
  failWriteNumber = 3;
  const first = await queue.flushQueue({ recordActualField: handler });
  assert.deepEqual(sends, ["7"]);
  assert.equal(first.readStatus, "STORAGE_UNAVAILABLE", "an unstorable settlement must be reported, never counted as clean");
  assert.equal(first.flushed, 0);

  // Storage recovers. Re-sending would now be answered STALE_READING
  // (the server already advanced past version 0) and would turn an
  // ACCEPTED reading into a rejected one — the exact false rejection
  // this reconciliation exists to prevent.
  failWriteNumber = null;
  const second = await queue.flushQueue({ recordActualField: handler });
  assert.deepEqual(sends, ["7"], "must not re-send a value the server already accepted");
  assert.equal(second.flushed, 1);
  assert.deepEqual(queue.peekQueue().items, []);
  assert.deepEqual(queue.peekRejected().items, [], "an accepted reading must never end up in the rejected list");
});

// PL-R13-P2-02, thirteenth production-lifecycle review: the composite of
// the two cases above, which the per-case fixes did not cover together.
// The unsettled-APPLIED memo was keyed by `id:generation`, but a newer
// offline edit bumps the generation while keeping the pre-offline
// expectedVersion — so the memo was invisible on the next flush, the
// newer value went out against a version the server had already moved
// past, and came back STALE_READING. A false rejection for a conflict
// that never happened.
test("an unstorable APPLIED followed by a newer offline edit still sends the newer value once, at the right version, with no false rejection", async () => {
  const inner = memoryStorage();
  let writes = 0;
  let failWriteNumber: number | null = null;
  const storage: StorageAdapter = {
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      writes += 1;
      if (writes === failWriteNumber) throw new Error("simulated quota failure");
      inner.setItem(key, value);
    },
  };
  const queue = createOfflineQueue(storage, sharedLock());
  const identity = { batchTicketId: "t1", componentId: "c1", field: "actual" };
  await queue.enqueue("recordActualField", { ...identity, value: "10", expectedVersion: "0" }); // write 1

  let serverVersion = 0;
  let serverValue: string | null = null;
  const sent: { value: string; expectedVersion: string }[] = [];
  const handler = async (fields: Record<string, string>): Promise<ReplayOutcome> => {
    sent.push({ value: fields.value, expectedVersion: fields.expectedVersion });
    if (Number(fields.expectedVersion) !== serverVersion) return { status: "REJECTED", reason: "STALE_READING" };
    serverVersion += 1;
    serverValue = fields.value;
    return { status: "APPLIED", version: serverVersion };
  };

  // 1+2. Value 10 applies on the server (version → 1), but the
  //      settlement write fails (write 3: claim is write 2).
  failWriteNumber = 3;
  const first = await queue.flushQueue({ recordActualField: handler });
  assert.equal(first.readStatus, "STORAGE_UNAVAILABLE");
  assert.deepEqual(sent, [{ value: "10", expectedVersion: "0" }]);
  assert.equal(serverValue, "10");

  // 3. A newer offline reading coalesces onto the same item: generation
  //    bumps, expectedVersion stays at the pre-offline 0.
  failWriteNumber = null;
  assert.equal((await queue.enqueue("recordActualField", { ...identity, value: "20", expectedVersion: "0" })).status, "OK");

  // 4+5. The next flush must send 20 exactly once, against the version
  //      the server actually reached (1) — not against the stale 0, which
  //      would come back STALE_READING and dead-letter the operator's
  //      latest reading for no real conflict.
  const second = await queue.flushQueue({ recordActualField: handler });
  assert.deepEqual(sent, [
    { value: "10", expectedVersion: "0" },
    { value: "20", expectedVersion: "1" },
  ]);
  assert.equal(serverValue, "20");
  assert.equal(second.flushed, 1);
  assert.deepEqual(queue.peekQueue().items, [], "the newer reading must be fully settled");
  assert.deepEqual(queue.peekRejected().items, [], "and never rejected — there was no real conflict at any point");
});

// A fake recordActualField server, standing in for the real Server
// Action: it holds the reading as a NUMBER (the database column's own
// type — see BatchComponentActual.actualMassKg), parses the submitted
// text exactly the way recordActualField does before writing it, and
// enforces the same per-field optimistic-version check. Its answers are
// real RecordActualFieldResult values, so what the handler under test
// runs is the production mapping (toReplayOutcome), not a paraphrase of
// it living in this file.
function fakeFieldServer() {
  const state = { version: 0, value: null as number | null, sends: [] as string[] };
  const send = async (fields: Record<string, string>): Promise<RecordActualFieldResult> => {
    state.sends.push(fields.value);
    const parsed = Number(fields.value);
    if (!Number.isFinite(parsed) || parsed < 0) return { status: "INVALID_VALUE" };
    if (Number(fields.expectedVersion) !== state.version) {
      // PL-R14-P2-03: the refusal reports what the server actually holds.
      return { status: "STALE_READING", currentVersion: state.version, currentValue: state.value };
    }
    state.version += 1;
    state.value = parsed;
    return { status: "OK", version: state.version };
  };
  // Exactly the handler OfflineSyncBanner registers, minus the FormData
  // transport: the REAL result-to-outcome mapping.
  const handler = async (fields: Record<string, string>): Promise<ReplayOutcome> => toReplayOutcome(await send(fields), fields);
  return { state, send, handler };
}

// PL-R14-P2-03, fourteenth production-lifecycle review: the in-memory
// reconciliation above only covers ONE queue instance. If the tab is
// closed or reloaded, or another tab picks the queue up, that map is gone
// — and the surviving queued item still carries its pre-offline version,
// so a naive replay is refused as STALE_READING and the operator's
// already-accepted reading is dead-lettered as a false conflict.
//
// The durable half of the fix is server-side: STALE_READING now reports
// the value and version the server actually holds, so ANY client can tell
// "this is already the value I sent" from a real conflict.
//
// PL-R15-P2-01, fifteenth production-lifecycle review: this test used to
// send "12.5" on both sides, so what it actually proved was TEXT
// equality — and text equality is precisely what was broken. The reading
// here is entered as "12.50" (an ordinary thing to type into a number
// input, and what the queue stores verbatim) against a server holding
// 12.5, which is the SAME measurement. The two must reconcile.
test("a new queue instance over surviving state does not falsely reject a reading the server already holds", async () => {
  const inner = memoryStorage();
  let writes = 0;
  let failWriteNumber: number | null = null;
  const storage: StorageAdapter = {
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      writes += 1;
      if (writes === failWriteNumber) throw new Error("simulated quota failure");
      inner.setItem(key, value);
    },
  };
  const lock = sharedLock();
  const server = fakeFieldServer();

  // Session 1: the server accepts the reading, but the settlement write
  // fails (write 1 = enqueue, 2 = claim, 3 = settle).
  const session1 = createOfflineQueue(storage, lock);
  await session1.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "12.50", expectedVersion: "0" });
  failWriteNumber = 3;
  const first = await session1.flushQueue({ recordActualField: server.handler });
  assert.equal(first.readStatus, "STORAGE_UNAVAILABLE");
  assert.deepEqual(server.state.sends, ["12.50"]);
  assert.equal(server.state.value, 12.5, "the server stores the parsed measurement, not the text the operator typed");

  // Session 2: a brand-new instance — the tab reloaded, or another tab
  // took over. Nothing of session 1's in-memory state survives.
  failWriteNumber = null;
  const session2 = createOfflineQueue(storage, lock);
  assert.equal(session2.peekQueue().items.length, 1, "the item is still queued, still carrying its pre-offline version");

  // Session 1 died holding the claim, so session 2 is correctly locked
  // out until that lease lapses — which is exactly what the wall clock
  // does 60s after a tab disappears. Expiring it here is what makes the
  // takeover happen now rather than making the test wait for it.
  const stored = JSON.parse(inner.getItem("bl_offline_queue_v1")!);
  stored.pending[0].leaseExpiresAt = Date.now() - 1000;
  inner.setItem("bl_offline_queue_v1", JSON.stringify(stored));

  const second = await session2.flushQueue({ recordActualField: server.handler });
  assert.deepEqual(server.state.sends, ["12.50", "12.50"], "the new instance re-sends, having no memory of the accepted result");
  assert.equal(second.flushed, 1, "and the server's answer identifies it as already applied, not a conflict");
  assert.deepEqual(session2.peekQueue().items, [], "so the item settles");
  assert.deepEqual(session2.peekRejected().items, [], "and the operator's accepted reading is never dead-lettered as a false conflict");
});

// The other half of PL-R15-P2-01: reconciling equivalent numbers must not
// quietly reconcile DIFFERENT ones. A genuine conflict — somebody else's
// newer reading on the same field — still has to reach the operator.
test("a genuine conflict on a replayed reading is still rejected, not absorbed as already-applied", async () => {
  const storage = memoryStorage();
  const server = fakeFieldServer();
  const queue = createOfflineQueue(storage, sharedLock());

  // Another writer (another tab, the bulk save, another device) already
  // recorded 12.6 against this field, so the server is at version 1.
  await server.send({ batchTicketId: "t1", componentId: "c1", field: "actual", value: "12.6", expectedVersion: "0" });

  await queue.enqueue("recordActualField", { batchTicketId: "t1", componentId: "c1", field: "actual", value: "12.50", expectedVersion: "0" });
  const result = await queue.flushQueue({ recordActualField: server.handler });

  assert.equal(result.flushed, 0, "nothing was applied — the replay was refused");
  assert.equal(result.remaining, 0, "and the item does not sit in the queue retrying a write that will never be accepted");
  assert.equal(server.state.value, 12.6, "the other writer's reading stands — a replay must never overwrite it");
  assert.deepEqual(
    queue.peekRejected().items.map((i) => i.reason),
    ["STALE_READING"],
    "a real disagreement between the queued value and the server's value must surface to the operator",
  );
});

// Unit coverage for the mapping itself, exercised directly rather than
// through the queue — these are the boundary cases that decide whether an
// operator's reading is silently swallowed or falsely dead-lettered, and
// they would each need a full replay setup to reach otherwise.
test("toReplayOutcome settles equivalent numeric representations and nothing else", () => {
  const staleAt = (currentValue: number | null): RecordActualFieldResult => ({ status: "STALE_READING", currentVersion: 7, currentValue });

  assert.deepEqual(toReplayOutcome({ status: "OK", version: 3 }, { value: "12.50" }), { status: "APPLIED", version: 3 });
  // Same measurement, different text — the case that used to dead-letter.
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: "12.50" }), { status: "APPLIED", version: 7 });
  assert.deepEqual(toReplayOutcome(staleAt(1.5), { value: "001.500" }), { status: "APPLIED", version: 7 });
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: " 12.5 " }), { status: "APPLIED", version: 7 }, "Number() ignores surrounding whitespace, and so must this");
  // Genuinely different measurements stay conflicts.
  assert.deepEqual(toReplayOutcome(staleAt(12.6), { value: "12.50" }), { status: "REJECTED", reason: "STALE_READING" });
  // Nothing that isn't a finite number may ever settle an item: a blank
  // value, junk text, and a server row that no longer holds a reading at
  // all must all keep flowing down the genuine-conflict path.
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: "" }), { status: "REJECTED", reason: "STALE_READING" });
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: "   " }), { status: "REJECTED", reason: "STALE_READING" });
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: "twelve" }), { status: "REJECTED", reason: "STALE_READING" });
  assert.deepEqual(toReplayOutcome(staleAt(12.5), { value: "Infinity" }), { status: "REJECTED", reason: "STALE_READING" });
  assert.deepEqual(toReplayOutcome(staleAt(null), { value: "12.50" }), { status: "REJECTED", reason: "STALE_READING" });
  // `Number("")` is 0, so a blank value would "equal" a server reading of
  // 0 under any comparison that skipped the emptiness check first — the
  // trap sameFiniteReading exists to refuse.
  assert.equal(sameFiniteReading("", 0), false);
  assert.equal(sameFiniteReading("0", 0), true);
  assert.equal(sameFiniteReading(undefined, 0), false);
  // Every other typed refusal is a rejection, unchanged.
  assert.deepEqual(toReplayOutcome({ status: "TERMINAL" }, { value: "12.50" }), { status: "REJECTED", reason: "TERMINAL" });
  assert.deepEqual(toReplayOutcome({ status: "NOT_FOUND" }, { value: "12.50" }), { status: "REJECTED", reason: "NOT_FOUND" });
  assert.deepEqual(toReplayOutcome({ status: "INVALID_VALUE" }, { value: "12.50" }), { status: "REJECTED", reason: "INVALID_VALUE" });
});

test("two concurrent flush attempts against the same storage produce no duplicate rejected item and no lost pending item", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, sharedLock());
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
  const queue = createOfflineQueue(storage, sharedLock());
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [], rejected: [{ id: "r1", kind: "recordActualField", fields: { value: "5" }, createdAt: 1, reason: "TERMINAL", rejectedAt: 2 }] }));

  const failing = createOfflineQueue(throwingStorage({ onSetItem: true }), sharedLock());
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
  const seedQueue = createOfflineQueue(storage, sharedLock());
  await seedQueue.enqueue("recordActualField", { value: "1" });
  const seededRaw = storage.store.get("bl_offline_queue_v1");
  assert.ok(seededRaw);

  const readFailing: StorageAdapter = {
    getItem: () => {
      throw new Error("simulated getItem failure");
    },
    setItem: storage.setItem,
  };
  const queue = createOfflineQueue(readFailing, sharedLock());

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
  const queue = createOfflineQueue(backupFailing, sharedLock());

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
  const queue = createOfflineQueue(storage, sharedLock());

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
  const queue = createOfflineQueue(storage, sharedLock());

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "RECOVERED_FROM_CORRUPT", "a malformed item must be treated as a corrupt payload, not silently trusted");
  assert.deepEqual(peeked.items, []);
});

test("`fields` stored as an array is rejected as corrupt, never trusted as a Record<string, string>", () => {
  const storage = memoryStorage();
  // typeof [] === "object" and Object.values([...]) both accept an array
  // — the exact gap PL-R9-P2-01 closed in isStringRecord.
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [{ id: "p1", kind: "recordActualField", fields: ["not", "a", "record"], createdAt: 1 }], rejected: [] }));
  const queue = createOfflineQueue(storage, sharedLock());

  const peeked = queue.peekQueue();
  assert.equal(peeked.readStatus, "RECOVERED_FROM_CORRUPT", "an array-shaped fields must be treated as corrupt, not silently accepted");
  assert.deepEqual(peeked.items, []);
});

// ---- PL-R10-P2-02, tenth production-lifecycle review: the old no-lock
// ---- fallback ran every mutation unserialized, reasoning "no worse than
// ---- before Web Locks existed" — Round 10 named that a real, still-
// ---- lossy fallback, since it silently reintroduces the exact cross-tab
// ---- race Round 9 set out to close for exactly the clients that can't
// ---- defend against it. Every mutating operation now fails CLOSED with
// ---- no lock instead. `lock: null` here stands in for whatever
// ---- getDefaultLock() itself returns on a real browser/runtime without
// ---- the Web Locks API (this Node test runner's own build happens to
// ---- ship a native navigator.locks, so getDefaultLock() would NOT
// ---- return null here — the explicit null is what actually exercises
// ---- the fallback path deterministically, in this environment and any
// ---- other).

test("with no lock available, enqueue/dismissRejected/flushQueue all fail closed — never proceed unserialized", async () => {
  const storage = memoryStorage();
  const queue = createOfflineQueue(storage, null); // the real no-Web-Locks fallback

  const enqueued = await queue.enqueue("recordActualField", { value: "10" });
  assert.equal(enqueued.status, "STORAGE_UNAVAILABLE", "enqueue must refuse, not silently perform the known-lossy unserialized mutation");
  assert.deepEqual(queue.peekQueue().items, [], "nothing may have been written");

  // Seed a rejected item directly through storage (bypassing the queue's
  // own gate) so dismissRejected has something to refuse to touch.
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [], rejected: [{ id: "r1", kind: "recordActualField", fields: { value: "5" }, createdAt: 1, reason: "TERMINAL", rejectedAt: 2 }] }));
  const dismissed = await queue.dismissRejected("r1");
  assert.equal(dismissed.status, "STORAGE_UNAVAILABLE");
  assert.equal(queue.peekRejected().items.length, 1, "a refused dismiss must leave the rejected item exactly as it was");

  // Seed a pending item directly the same way, so flushQueue has
  // something it could otherwise have (unsafely) applied.
  storage.setItem("bl_offline_queue_v1", JSON.stringify({ version: 1, pending: [{ id: "p1", kind: "recordActualField", fields: { value: "10" }, createdAt: 1 }], rejected: [] }));
  const flushResult = await queue.flushQueue({ recordActualField: async () => ({ status: "APPLIED" }) });
  assert.equal(flushResult.readStatus, "STORAGE_UNAVAILABLE", "flushQueue must report the same fail-closed status, not silently apply the handler's own successful outcome");
  assert.equal(flushResult.flushed, 0);
  assert.equal(queue.peekQueue().items.length, 1, "the item must remain queued, untouched, for a later flush once a lock is available");
});

// The review's own explicit ask: a two-instance test for the ACTUAL
// fallback path, not only an injected ideal lock. Two tabs, neither with
// Web Locks available (both instances built with no lock, exactly like
// getDefaultLock() would return for both in a real unsupported browser),
// racing an enqueue for the SAME origin storage: the old fallback would
// have let this race silently lose one reading. Now both instances
// simply refuse — a real (if inconvenient) safety, never a silent loss.
test("two-instance fallback with no lock on either side: both refuse rather than silently racing", async () => {
  const storage = memoryStorage();
  const tab1 = createOfflineQueue(storage, null);
  const tab2 = createOfflineQueue(storage, null);

  const [r1, r2] = await Promise.all([tab1.enqueue("recordActualField", { field: "actual", value: "10" }), tab2.enqueue("recordActualField", { field: "moisture", value: "3" })]);
  assert.equal(r1.status, "STORAGE_UNAVAILABLE");
  assert.equal(r2.status, "STORAGE_UNAVAILABLE");
  assert.deepEqual(tab1.peekQueue().items, [], "neither tab's reading may have been silently written without a way to serialize the two");
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
