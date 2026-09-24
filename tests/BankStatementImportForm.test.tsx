// Rendered-component test for src/components/BankStatementImportForm.tsx.
// importBankStatement used to return void, so a repeat upload, a file
// with nothing importable in it and a real import all looked the same:
// the page reloaded. Every outcome must now render, in both languages, and
// only a real import may look like success.
//
// Same jsdom-globals-before-import ordering as tests/RecordActualsForm.test.tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ImportBankStatementState } from "../src/app/(app)/finance/actions";

// The component's default `action` is the real importBankStatement, so
// importing it loads actions.ts's module graph, which imports "server-only".
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
setGlobal("FormData", dom.window.FormData);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { BankStatementImportForm } = await import("../src/components/BankStatementImportForm");
const arModule = await import("../src/lib/i18n/dictionaries/ar");
const enModule = await import("../src/lib/i18n/dictionaries/en");

// Under tsx the dictionaries may load as CommonJS, with the dictionary one
// `default` deeper; unwrap whichever shape arrives.
function unwrapDefault<T>(m: T): T {
  let v: unknown = m;
  while (v && typeof v === "object" && "default" in v && !("modules" in v)) v = (v as { default: unknown }).default;
  return v as T;
}
const ar = unwrapDefault(arModule.default);
const en = unwrapDefault(enModule.default);

function messagesFor(dict: typeof ar) {
  const r = dict.modules.finance.reconciliation;
  return { site: r.importSite, file: r.importFile, button: r.importButton, ...r.importResult };
}

const SITES = [{ id: "site-a", code: "A", name: "Plant A" }];
const CLASSES = { label: "", select: "", input: "", button: "" };

async function submitWith(state: ImportBankStatementState, dict = en) {
  const received: FormData[] = [];
  const action = async (_prev: ImportBankStatementState, data: FormData) => {
    received.push(data);
    return state;
  };
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  React.act(() => {
    root.render(<BankStatementImportForm sites={SITES} messages={messagesFor(dict)} timeZone="Asia/Riyadh" classNames={CLASSES} action={action} />);
  });
  const form = container.querySelector("form") as HTMLFormElement;
  await React.act(async () => {
    form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const result = {
    alert: container.querySelector('[role="alert"]'),
    status: container.querySelector('[role="status"]'),
    text: container.textContent ?? "",
    received,
  };
  await React.act(async () => {
    root.unmount();
  });
  container.remove();
  return result;
}

test("nothing is shown before a submit", async () => {
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  React.act(() => {
    root.render(<BankStatementImportForm sites={SITES} messages={messagesFor(en)} timeZone="Asia/Riyadh" classNames={CLASSES} action={async () => null} />);
  });
  assert.equal(container.querySelector('[role="alert"],[role="status"]'), null);
  await React.act(async () => {
    root.unmount();
  });
});

test("a real import is the only outcome shown as success, with its counts and skipped rows", async () => {
  const r = await submitWith({ status: "IMPORTED", lineCount: 12, matchedCount: 5, rowErrors: [{ row: 4, code: "BAD_AMOUNT", value: "1e3" }], rowErrorCount: 1 });
  assert.equal(r.received.length, 1, "the form submits to the action");
  assert.equal(r.received[0].get("siteId"), "site-a");
  assert.ok(r.status, "success renders as a status, not an alert");
  assert.equal(r.alert, null);
  assert.match(r.status!.textContent ?? "", /Imported 12 statement lines; 5 matched automatically\./);
  assert.match(r.status!.textContent ?? "", /Row 4: unrecognized or zero amount "1e3"/);
});

test("a re-upload of the same file says it was already imported, with the date, and is not shown as success", async () => {
  const r = await submitWith({ status: "ALREADY_IMPORTED", importedAt: "2026-09-20T09:30:00.000Z" });
  assert.equal(r.status, null);
  assert.ok(r.alert);
  // 09:30 UTC is 12:30 in Riyadh: the date is shown in the plant's zone.
  assert.equal(r.alert!.textContent, "This exact file was already imported for this site on 20/09/2026, 12:30. Nothing was added.");
});

for (const [identity, pattern] of [
  ["LEGACY_TEXT", /before files were identified by their exact bytes/],
  ["DIFFERENT_BYTES", /A different file with identical content/],
] as const) {
  test(`a statement needing review (${identity}) says it was not imported and why`, async () => {
    const r = await submitWith({ status: "NEEDS_REVIEW", importedAt: "2026-08-01T00:00:00.000Z", earlierIdentity: identity });
    assert.ok(r.alert);
    assert.match(r.alert!.textContent ?? "", /^Not imported: needs review\./);
    assert.match(r.alert!.textContent ?? "", pattern);
    assert.match(r.alert!.textContent ?? "", /Nothing was added\./);
  });
}

test("a file with no readable rows lists why each row was refused", async () => {
  const r = await submitWith({
    status: "NO_LINES",
    rowErrors: [
      { row: 2, code: "BAD_DATE", value: "yesterday" },
      { row: 3, code: "BAD_AMOUNT", value: "Infinity" },
    ],
    rowErrorCount: 25,
  });
  assert.ok(r.alert);
  const items = [...r.alert!.querySelectorAll("li")].map((li) => li.textContent);
  assert.deepEqual(items, ['Row 2: unrecognized date "yesterday"', 'Row 3: unrecognized or zero amount "Infinity"']);
  assert.match(r.alert!.textContent ?? "", /Nothing imported: no row in this file could be read\./);
  assert.match(r.alert!.textContent ?? "", /25 rows skipped:/);
  assert.match(r.alert!.textContent ?? "", /…and 23 more\./, "the capped list says how many rows it left out");
});

test("a failed import is shown as a failure the uploader can retry", async () => {
  const r = await submitWith({ status: "FAILED" });
  assert.equal(r.alert?.textContent, "The import failed and nothing was saved. You can retry the same file.");
});

test("a status the form does not know still renders a failure, never silence", async () => {
  const r = await submitWith({ status: "SOMETHING_NEW" } as unknown as ImportBankStatementState);
  assert.equal(r.alert?.textContent, en.modules.finance.reconciliation.importResult.failed);
});

test("every outcome renders in Arabic too", async () => {
  const cases: [ImportBankStatementState, RegExp][] = [
    [{ status: "IMPORTED", lineCount: 3, matchedCount: 1, rowErrors: [], rowErrorCount: 0 }, /تم استيراد 3 من سطور الكشف، وطوبق منها تلقائيًا 1\./],
    [{ status: "ALREADY_IMPORTED", importedAt: "2026-09-20T09:30:00.000Z" }, /استُورد لهذا الموقع بتاريخ 20\/09\/2026/],
    [{ status: "NEEDS_REVIEW", importedAt: "2026-08-01T00:00:00.000Z", earlierIdentity: "LEGACY_TEXT" }, /^لم يُستورد: يحتاج مراجعة\./],
    [{ status: "NO_LINES", rowErrors: [{ row: 2, code: "BAD_DATE", value: "x" }], rowErrorCount: 1 }, /السطر 2: تاريخ غير مفهوم "x"/],
    [{ status: "INVALID_REQUEST" }, /اختر الموقع وملف الكشف\./],
    [{ status: "FAILED" }, /فشل الاستيراد ولم يُحفظ شيء\./],
  ];
  for (const [state, pattern] of cases) {
    const r = await submitWith(state, ar);
    const box = r.status ?? r.alert;
    assert.ok(box, `${state?.status} must render`);
    assert.match(box!.textContent ?? "", pattern);
    assert.doesNotMatch(box!.textContent ?? "", /\{\w+\}/, "no placeholder may be left unfilled");
  }
});
