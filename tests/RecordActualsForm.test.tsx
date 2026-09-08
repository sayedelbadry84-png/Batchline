// Rendered-component test for src/components/RecordActualsForm.tsx —
// PL-R10-P1-04, tenth production-lifecycle review: recordActuals used to
// be a bare void-returning action bound straight to a plain
// <form action={recordActuals}> on both the production and operator
// ticket pages. A STALE_READING result — the entire bulk write correctly
// rolled back by claimAndRecordActuals (PL-R9-P1-03) — had no way to
// reach either page: the form just silently reloaded, recreating exactly
// the false-success appearance the version work was meant to eliminate.
//
// Same jsdom-globals-before-import ordering as tests/AutoSaveField.test.tsx
// — see that file's own top comment for why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
// Type-only — erased at compile time, so naming the state shape never by
// itself pulls in actions.ts's own runtime module graph.
import type { RecordActualsActionState } from "../src/app/(app)/production/actions";

// RecordActualsForm's default `action` parameter is the REAL recordActuals
// (from actions.ts), so importing the component below — even though every
// test here overrides that prop with its own fake action — still
// transitively loads actions.ts's whole module graph (session.ts,
// materialRequisition.ts, batchCompletion.ts, ...), several of which
// `import "server-only"`, which throws outside a real Next.js server
// context. Same stub every other test file with a server-only dependency
// chain already uses.
createRequire(import.meta.url)("./setup/stubServerOnly.cjs");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("navigator", dom.window.navigator);
setGlobal("HTMLElement", dom.window.HTMLElement);
setGlobal("HTMLFormElement", dom.window.HTMLFormElement);
setGlobal("HTMLButtonElement", dom.window.HTMLButtonElement);
setGlobal("Event", dom.window.Event);
setGlobal("SubmitEvent", dom.window.SubmitEvent);
// React's form-action submit handling constructs `new FormData(form,
// submitter)` — an HTMLFormElement-aware overload only jsdom's OWN
// FormData class implements. Node's native global FormData (undici) has
// no idea what to do with a jsdom form element and throws.
setGlobal("FormData", dom.window.FormData);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RecordActualsForm } = await import("../src/components/RecordActualsForm");

function mount(action: (prevState: RecordActualsActionState, formData: FormData) => Promise<RecordActualsActionState>) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  React.act(() => {
    root.render(
      <RecordActualsForm ticketId="test-ticket" messages={{ staleConflict: "Not saved — readings changed elsewhere." }} action={action}>
        <button type="submit">Save readings</button>
      </RecordActualsForm>,
    );
  });
  const form = container.querySelector("form") as HTMLFormElement;
  const button = container.querySelector("button") as HTMLButtonElement;
  const unmount = async () => {
    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { container, form, button, unmount };
}

test("RecordActualsForm: a STALE_READING result renders a visible conflict banner, never silently looking like success", async () => {
  const action = async (): Promise<RecordActualsActionState> => ({ status: "STALE_READING" });
  const { container, button, unmount } = mount(action);

  assert.equal(container.querySelector('[role="alert"]'), null, "no banner before any submit");

  await React.act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, "a STALE_READING result must render a visible alert — the operator must never see a silent no-op reload");
  assert.match(alert!.textContent ?? "", /Not saved/, "the banner must actually say the write was not saved, not a generic/blank message");

  await unmount();
});

test("RecordActualsForm: an OK result renders no conflict banner", async () => {
  const action = async (): Promise<RecordActualsActionState> => ({ status: "OK" });
  const { container, button, unmount } = mount(action);

  await React.act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });

  assert.equal(container.querySelector('[role="alert"]'), null, "a genuine success must never show the stale-conflict banner");
  await unmount();
});

test("RecordActualsForm: a TERMINAL result renders no STALE_READING-specific banner (a different, already-established rejection path)", async () => {
  const action = async (): Promise<RecordActualsActionState> => ({ status: "TERMINAL" });
  const { container, button, unmount } = mount(action);

  await React.act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });

  // TERMINAL (ticket went COMPLETE/CANCELLED mid-edit) is a different,
  // pre-existing rejection this component doesn't render text for today
  // — this test only pins that it is NOT mistaken for the STALE_READING
  // banner specifically, so a future regression can't silently merge the
  // two into one misleading message.
  assert.equal(container.querySelector('[role="alert"]'), null);
  await unmount();
});
