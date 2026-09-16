// The access-denied page must not repeat anything from the URL. It used to
// print `?module=` back inside a sentence, so the page named what had been
// refused and would vouch for any text a link-maker put there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const AccessDeniedPage = (await import("../src/app/(app)/access-denied/page")).default;

test("the access-denied page is generic and takes nothing from the URL", () => {
  assert.equal(AccessDeniedPage.length, 0, "the page accepts no props, so no query parameter can reach its copy");
  const html = renderToStaticMarkup(React.createElement(AccessDeniedPage));
  for (const name of ["users", "audit-log", "permissions", "roles", "integrations"]) {
    assert.ok(!html.includes(name), `the refusal must not name "${name}"`);
  }
});

test("no redirect to access-denied carries a module name any more", () => {
  const files = ["src/lib/session.ts", ...["users", "audit-log", "permissions", "roles", "integrations"].map((m) => `src/app/(app)/${m}/page.tsx`)];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(!/access-denied\?module=/.test(source), `${file} still appends ?module=`);
  }
});
