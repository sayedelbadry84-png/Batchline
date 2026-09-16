// Rendered-component test for src/components/NotificationPermissionButton.
//
// An end-to-end pass reported "no visible reconciliation indicator ... on
// dashboard load" for a device that already had a push subscription. The
// reconciliation itself already ran; what was missing was anything on
// screen while it did, and any distinction between "never set up" and "set
// up here but the server would not take it back". These cases pin the
// states a person with the phone in their hand actually sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// The component decides "unsupported" from these at mount, so they must
// exist before it renders.
Object.defineProperty(dom.window, "PushManager", { configurable: true, value: function PushManager() {} });
setGlobal("Notification", { permission: "granted" });

let currentSubscription: { toJSON: () => unknown } | null = null;
Object.defineProperty(dom.window.navigator, "serviceWorker", {
  configurable: true,
  value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => currentSubscription } }) },
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { NotificationPermissionButton } = await import("../src/components/NotificationPermissionButton");

const labels = {
  enableLabel: "Enable",
  enabledLabel: "Enabled",
  deniedLabel: "Blocked",
  checkingLabel: "Checking…",
  resyncFailedLabel: "Set up here but not reconnected",
  retryLabel: "Retry",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(NotificationPermissionButton, labels));
  });
  const state = () => container.querySelector("[data-state]")?.getAttribute("data-state") ?? null;
  const unmount = async () => {
    await React.act(async () => root.unmount());
    container.remove();
  };
  return { container, state, unmount };
}

async function settle() {
  for (let i = 0; i < 5; i++) await React.act(async () => new Promise((r) => setTimeout(r, 0)));
}

test("while an existing subscription is being reconciled, the page says so", async () => {
  currentSubscription = { toJSON: () => ({ endpoint: "https://push.example/1" }) };
  const pending = deferred<{ ok: boolean }>();
  setGlobal("fetch", () => pending.promise);

  const view = await mount();
  await settle();
  // The defect: this state rendered nothing at all.
  assert.equal(view.state(), "checking");
  assert.match(view.container.textContent ?? "", /Checking…/);
  assert.equal(view.container.querySelector('[role="status"]')?.getAttribute("aria-live"), "polite");

  pending.resolve({ ok: true });
  await settle();
  assert.equal(view.state(), "enabled", "a subscription the server re-registered is reported enabled");
  await view.unmount();
});

test("a subscription the server will not re-register is shown as needing a retry, not as never set up", async () => {
  currentSubscription = { toJSON: () => ({ endpoint: "https://push.example/2" }) };
  let calls = 0;
  setGlobal("fetch", async () => {
    calls += 1;
    return { ok: calls > 1 };
  });

  const view = await mount();
  await settle();
  assert.equal(view.state(), "resyncFailed");
  assert.match(view.container.textContent ?? "", /not reconnected/);

  const retry = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  assert.ok(retry, "the failed state offers a retry");
  await React.act(async () => {
    retry!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
  assert.equal(calls, 2, "retry re-runs the reconciliation");
  assert.equal(view.state(), "enabled");
  await view.unmount();
});

test("a device with no subscription goes straight to the enable button", async () => {
  currentSubscription = null;
  setGlobal("fetch", async () => {
    throw new Error("must not be called without a subscription");
  });
  const view = await mount();
  await settle();
  assert.equal(view.state(), "idle");
  await view.unmount();
});
