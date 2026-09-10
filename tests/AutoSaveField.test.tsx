// Rendered-component test for src/components/AutoSaveField.tsx — the one
// disclosed gap every prior round's test suite named but never closed:
// "AutoSaveField's own per-field save-coalescing is React component
// behavior with no DOM to render it against" (see offlineQueue.test.ts's
// own top comment). PL-R9-P2-04, ninth production-lifecycle review, asks
// for exactly this.
//
// jsdom globals MUST be assigned before AutoSaveField (or its own
// offlineQueue import) is ever loaded — offlineQueue.ts's default export
// is a module-level singleton whose storage adapter is decided once, at
// import time, by `typeof window === "undefined"`. A static top-level
// import here would already have pulled that module in before this
// file's own top-level code ran; the dynamic imports below (after the
// jsdom globals are assigned) are what makes the ordering actually work,
// the same technique batchCompletion.test.ts already uses to redirect
// DATABASE_URL before its own domain imports load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
// Object.defineProperty, not a plain assignment — Node 21+ ships its own
// read-only `navigator` global getter, which a plain `global.navigator =`
// throws against ("Cannot set property navigator... which has only a
// getter"). `configurable: true` lets this override it cleanly.
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("HTMLInputElement", dom.window.HTMLInputElement);
setGlobal("Event", dom.window.Event);
setGlobal("FocusEvent", dom.window.FocusEvent);
// jsdom's own navigator doesn't implement the Web Locks API at all —
// offlineQueue.ts's getDefaultLock() would see that exactly as it would
// a real unsupported browser and return null, which (PL-R10-P2-02) now
// makes every offline mutation fail closed. A minimal, real FIFO-mutex
// polyfill (same guarantee sharedLock() in offlineQueue.test.ts models)
// is what actually lets this file's offline test exercise genuine
// enqueue/coalesce/replay behavior end to end against the real
// offlineQueue singleton below, rather than only proving the fail-closed
// path an already-covered offlineQueue.test.ts test proves on its own.
let lockTail: Promise<unknown> = Promise.resolve();
Object.defineProperty(dom.window.navigator, "locks", {
  configurable: true,
  value: {
    request(_name: string, callback: () => unknown) {
      const run = lockTail.then(() => callback());
      lockTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  },
});
// Tells React this is a real test environment so React.act() actually
// batches/flushes updates instead of just warning that it can't tell.
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { AutoSaveField } = await import("../src/components/AutoSaveField");
const { offlineQueue, logicalKey, emitReplaySuccess } = await import("../src/lib/offlineQueue");

function mountInput(props: Parameters<typeof AutoSaveField>[0]) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  React.act(() => {
    root.render(React.createElement(AutoSaveField, props));
  });
  const input = container.querySelector("input") as HTMLInputElement;
  const unmount = async () => {
    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { container, root, input, unmount };
}

function setValueAndBlur(input: HTMLInputElement, value: string) {
  input.value = value;
  // React's onBlur is implemented over the native, bubbling "focusout"
  // event (not the non-bubbling "blur"), same as every browser's own
  // event delegation React relies on outside jsdom too.
  input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// PL-R7-P2-01, seventh production-lifecycle review: two overlapping saves
// for the SAME field used to each start their own independent request
// with no ordering guarantee. inFlight/pendingValue serialize them — a
// blur that arrives while a save is already in flight must never start a
// second concurrent request; it must instead be picked up by the
// in-flight save's own completion handler, and only the truly LATEST
// value must ever be the last one actually sent.
test("AutoSaveField: a blur that arrives while a save is in flight is coalesced, not sent as a second concurrent request", async () => {
  const calls: string[] = [];
  const firstCallGate = deferred<void>();
  let resolveFirstSave!: (v: { status: string }) => void;

  const action = async (fd: FormData) => {
    const value = String(fd.get("value"));
    calls.push(value);
    if (calls.length === 1) {
      firstCallGate.resolve();
      return new Promise<{ status: string }>((resolve) => {
        resolveFirstSave = resolve;
      });
    }
    return { status: "OK" };
  };

  const { input, unmount } = mountInput({
    action,
    hiddenFields: {},
    valueField: "value",
    name: "test-field",
    defaultValue: "10",
    defaultVersion: 0,
  });

  // First blur starts the (still-pending) first save.
  await React.act(async () => {
    setValueAndBlur(input, "20");
    await firstCallGate.promise;
  });
  assert.deepEqual(calls, ["20"], "the first blur must start exactly one save");

  // A second, then a third, value arrive while that first save is still
  // in flight — handleBlur must queue only the LATEST one (pendingValue
  // overwritten, not appended), never start a concurrent second request.
  await React.act(async () => {
    setValueAndBlur(input, "21");
    setValueAndBlur(input, "22");
  });
  assert.deepEqual(calls, ["20"], "no second request may be sent while the first is still in flight, no matter how many blurs arrive");

  // The first save now resolves — its own completion handler must fire
  // the queued follow-up for the LATEST value only.
  await React.act(async () => {
    resolveFirstSave({ status: "OK" });
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(calls, ["20", "22"], "the follow-up save must carry only the truly latest value — 21 must never have been sent on its own");
  await unmount();
});

test("AutoSaveField: a rejected (non-OK) save never updates lastSaved, so the same value is retried on the next blur", async () => {
  const calls: string[] = [];
  const action = async (fd: FormData) => {
    const value = String(fd.get("value"));
    calls.push(value);
    return { status: "STALE_READING" };
  };

  const { input, unmount } = mountInput({
    action,
    hiddenFields: {},
    valueField: "value",
    name: "test-field-2",
    defaultValue: "5",
    defaultVersion: 0,
  });

  await React.act(async () => {
    setValueAndBlur(input, "9");
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(calls, ["9"]);

  // Blurring the SAME value again must re-send it — a rejected save must
  // never have been treated as "already saved" (lastSaved must still be
  // the original, un-applied value, not the rejected "9").
  await React.act(async () => {
    setValueAndBlur(input, "9");
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(calls, ["9", "9"], "a rejected save's value must still look unsaved, so an identical retry blur sends it again rather than being treated as a no-op");
  await unmount();
});

// PL-R10-P1-03, tenth production-lifecycle review: the deterministic
// failure sequence the round found — two offline edits to the same field
// used to enqueue as two SEPARATE items, both carrying the pre-offline
// version. Replay applied the OLDER value first (advancing the server's
// version), then rejected the genuinely latest value as STALE_READING.
// This exercises the real component + the real offlineQueue singleton
// (over jsdom's own localStorage) end to end, not a paraphrase of either.
test("AutoSaveField: two offline edits to the same field coalesce — exactly one server write with the latest value, no rejected latest, and the field learns the returned version", async () => {
  dom.window.localStorage.clear();
  const setOnLine = (value: boolean) => Object.defineProperty(dom.window.navigator, "onLine", { value, configurable: true });
  setOnLine(false);

  const calls: string[] = [];
  const sentVersions: string[] = [];
  const action = async (fd: FormData) => {
    calls.push(String(fd.get("value")));
    sentVersions.push(String(fd.get("expectedVersion")));
    return { status: "OK", version: 42 };
  };

  const hiddenFields = { batchTicketId: "test-offline-ticket", componentId: "test-offline-component", field: "actual" };
  const { input, unmount } = mountInput({
    action,
    hiddenFields,
    valueField: "value",
    name: "offline-field",
    defaultValue: "1",
    defaultVersion: 0,
    offlineQueueKind: "recordActualField",
  });

  // Two offline blurs to the SAME field — neither may reach `action` at
  // all (offline), and the second must coalesce onto the first in the
  // queue rather than enqueue a second, independently-stale-able item.
  await React.act(async () => {
    setValueAndBlur(input, "10");
    await new Promise((r) => setTimeout(r, 0));
  });
  await React.act(async () => {
    setValueAndBlur(input, "20");
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(calls, [], "neither offline blur may call the server action directly");

  const pending = offlineQueue.peekQueue().items;
  assert.equal(pending.length, 1, "two offline edits to the same field must coalesce into ONE queued item");
  assert.equal(pending[0].fields.value, "20");
  assert.equal(pending[0].fields.expectedVersion, "0");

  // "Reconnect": flush, simulating exactly what OfflineSyncBanner's own
  // real handler does — call the action and, on success, emit the
  // replay-success event this instance is subscribed to.
  setOnLine(true);
  let flushResult!: Awaited<ReturnType<typeof offlineQueue.flushQueue>>;
  await React.act(async () => {
    flushResult = await offlineQueue.flushQueue({
      recordActualField: async (fields) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.set(k, v);
        const result = await action(fd);
        // Synchronously triggers AutoSaveField's own onReplaySuccess
        // listener (a setStatus/ref update) — must run inside act() the
        // same as any other React-state-touching interaction in this file.
        emitReplaySuccess(logicalKey("recordActualField", fields), result.version);
        return { status: "APPLIED" };
      },
    });
  });

  assert.equal(flushResult.flushed, 1);
  assert.deepEqual(calls, ["20"], "exactly one server write may happen, containing the LATEST value — 10 must never reach the server on its own");
  assert.equal(offlineQueue.peekRejected().items.length, 0, "the latest value must never be rejected merely because an older queued sibling replayed first");

  // Give the emitted replay-success event's React state update a tick to
  // land before the next interaction.
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // The NEXT edit — now online — must carry the version the replay
  // actually RETURNED (42), not the stale pre-offline version (0),
  // proving this specific mounted instance learned it.
  await React.act(async () => {
    setValueAndBlur(input, "30");
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.deepEqual(calls, ["20", "30"]);
  assert.equal(sentVersions[1], "42", "the next save must use the version the offline replay returned, not the stale version this field started offline with");

  await unmount();
});
