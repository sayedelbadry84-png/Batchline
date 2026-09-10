// PR4-R4-P1-01: the demo seed must fail closed. No database — the guard is
// a pure decision, and that is the point: it runs before the seed script
// opens a connection or writes a single row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDemoSeedAllowed, DEMO_SEED_OPT_IN } from "../src/lib/seedGuard";

test("production is refused even with the opt-in present", () => {
  const result = checkDemoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: DEMO_SEED_OPT_IN });
  assert.equal(result.status, "REFUSED");
  if (result.status === "REFUSED") assert.match(result.reason, /production/i);
});

test("a development environment without the opt-in is refused", () => {
  for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
    assert.equal(checkDemoSeedAllowed(env).status, "REFUSED", `${JSON.stringify(env)} must not seed`);
  }
});

test("a near-miss opt-in is refused — the phrase is exact on purpose", () => {
  for (const value of ["yes", "true", "1", DEMO_SEED_OPT_IN.toUpperCase(), ` ${DEMO_SEED_OPT_IN}`, DEMO_SEED_OPT_IN.slice(0, -1)]) {
    assert.equal(
      checkDemoSeedAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: value }).status,
      "REFUSED",
      `${JSON.stringify(value)} must not be accepted as the opt-in`,
    );
  }
});

test("development plus the exact opt-in is allowed", () => {
  assert.deepEqual(checkDemoSeedAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: DEMO_SEED_OPT_IN }), { status: "ALLOWED" });
  // NODE_ENV is frequently unset when running a script directly.
  assert.deepEqual(checkDemoSeedAllowed({ ALLOW_DEMO_SEED: DEMO_SEED_OPT_IN }), { status: "ALLOWED" });
});
