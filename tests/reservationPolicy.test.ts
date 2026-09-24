// Pure-logic tests, no database: the credit comparison, the statuses the
// reservation edit form may set, and the result banner text in both
// languages. The database behaviour is in tests/reservationCredit.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
createRequire(import.meta.url)("./setup/stubServerOnly.cjs");
const { decideCredit } = await import("../src/lib/creditPolicy");
const { allowedEditStatuses, RESERVATION_STATUSES } = await import("../src/lib/reservationEdits");
const { describeReservationResult } = await import("../src/lib/reservationResultText");
const arModule = await import("../src/lib/i18n/dictionaries/ar");
const enModule = await import("../src/lib/i18n/dictionaries/en");

function unwrapDefault<T>(m: T): T {
  let v: unknown = m;
  while (v && typeof v === "object" && "default" in v && !("modules" in v)) v = (v as { default: unknown }).default;
  return v as T;
}
const ar = unwrapDefault(arModule.default);
const en = unwrapDefault(enModule.default);

test("decideCredit holds at the limit, compares in minor units, and treats a zero limit as no credit", () => {
  assert.equal(decideCredit(99.99, 100).status, "WITHIN_LIMIT");
  assert.equal(decideCredit(100, 100).status, "OVER_LIMIT");
  assert.equal(decideCredit(0.1 + 0.2, 0.3).status, "OVER_LIMIT", "float dust must not put a balance a hair under the limit");
  assert.equal(decideCredit(0, 0).status, "OVER_LIMIT");
  assert.deepEqual(decideCredit(12.34, 50), { status: "WITHIN_LIMIT", outstandingMinor: 1234, limitMinor: 5000 });
});

test("the edit form may only keep the current status or place a hold", () => {
  assert.deepEqual(allowedEditStatuses("CONFIRMED"), ["CONFIRMED", "ON_HOLD"]);
  assert.deepEqual(allowedEditStatuses("REQUESTED"), ["REQUESTED", "ON_HOLD"]);
  for (const status of ["ON_HOLD", "IN_PRODUCTION", "DELIVERED", "CANCELLED"]) {
    assert.deepEqual(allowedEditStatuses(status), [status], `${status} can only be kept as it is`);
  }
  // Nothing the form can reach is a release-ready or terminal state it was not already in.
  for (const from of RESERVATION_STATUSES) {
    for (const to of allowedEditStatuses(from)) {
      if (to === from) continue;
      assert.equal(to, "ON_HOLD", `${from} -> ${to} must not be possible from the edit form`);
    }
  }
});

test("every reservation result code renders in both languages, only CANCELLED as a success, and an unknown code renders nothing", () => {
  const codes = Object.keys(en.modules.reservations.result);
  assert.deepEqual(Object.keys(ar.modules.reservations.result).sort(), [...codes].sort());
  for (const dict of [ar, en]) {
    for (const code of codes) {
      const banner = describeReservationResult(dict.modules.reservations.result, code);
      assert.ok(banner && banner.text.length > 0, `${code} must have text`);
      assert.equal(banner!.ok, code === "CANCELLED");
    }
  }
  assert.equal(describeReservationResult(en.modules.reservations.result, "SOMETHING_ELSE"), null);
  assert.equal(describeReservationResult(en.modules.reservations.result, "toString"), null);
  assert.equal(describeReservationResult(en.modules.reservations.result, undefined), null);
});

test("the release refusal for credit has its own text on the production page, in both languages", () => {
  for (const dict of [ar, en]) {
    const r = dict.modules.production.releaseError;
    assert.ok(r.CREDIT_HOLD.length > 0 && r.CREDIT_HOLD !== r.INVALID_STATE);
    assert.ok(r.manualBookingHeldNote.length > 0 && r.manualBookingHeldNote !== r.manualBookingKeptNote);
  }
});
