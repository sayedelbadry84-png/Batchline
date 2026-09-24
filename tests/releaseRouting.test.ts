// Pure-logic tests for src/lib/releaseRouting.ts — no database, no
// Next.js request context, nothing to stub. RMR-R4-P2-01: the release
// actions used to concatenate a raw, form-supplied `returnPrefix` string
// straight into a redirect target, which is an open redirect for any
// authenticated caller who submits something other than the two values
// the UI itself ever sends. These functions replace that with a closed,
// server-derived allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReturnTarget, releaseSuccessPath, releaseFailurePath, parseTripReturnTarget, tripReturnPath, describeReleaseError } from "../src/lib/releaseRouting";
import arModule from "../src/lib/i18n/dictionaries/ar";
import enModule from "../src/lib/i18n/dictionaries/en";

// Under `tsx --test` these dictionary files load as CommonJS, so the
// default import arrives as the whole exports object ({ default: ... });
// under Next's bundler it is the dictionary itself. Unwrap either shape
// instead of depending on which loader ran this file.
function unwrapDefault<T>(m: T): T {
  return (m as { default?: T }).default ?? m;
}
const ar = unwrapDefault(arModule);
const en = unwrapDefault(enModule);

test("parseReturnTarget only ever returns 'operator' for the exact literal value the operator form sends", () => {
  assert.equal(parseReturnTarget("operator"), "operator");
});

test("parseReturnTarget falls back to 'production' for anything else, including an attempted open-redirect payload", () => {
  assert.equal(parseReturnTarget("production"), "production");
  assert.equal(parseReturnTarget(null), "production");
  assert.equal(parseReturnTarget(""), "production");
  assert.equal(parseReturnTarget("https://evil.example/phish"), "production");
  assert.equal(parseReturnTarget("//evil.example"), "production");
  assert.equal(parseReturnTarget("/operator/ticket"), "production");
  assert.equal(parseReturnTarget("Operator"), "production"); // case-sensitive, no fuzzy match
});

test("releaseSuccessPath builds a fixed, known route for each target — never an arbitrary one", () => {
  assert.equal(releaseSuccessPath("production", "tk_123"), "/production/tk_123");
  assert.equal(releaseSuccessPath("operator", "tk_123"), "/operator/ticket/tk_123");
});

test("releaseFailurePath returns to the real page for each target, not a route that doesn't exist", () => {
  const params = new URLSearchParams({ releaseError: "INVALID_STATE" });
  assert.equal(releaseFailurePath("production", params), "/production?releaseError=INVALID_STATE");
  // The operator failure path used to be `${returnPrefix}?...` where
  // returnPrefix was "/operator/ticket" — landing on "/operator/ticket?..."
  // (no id), a route that doesn't exist. It must be the real operator
  // home page instead.
  assert.equal(releaseFailurePath("operator", params), "/operator?releaseError=INVALID_STATE");
});

// PL-P2-02, first production-lifecycle review — startTrip's own returnTo
// field had the exact same open-redirect shape as returnPrefix above.
test("parseTripReturnTarget only ever returns 'operator' for the exact literal value the field view sends", () => {
  assert.equal(parseTripReturnTarget("operator"), "operator");
});

test("parseTripReturnTarget falls back to 'trips' for anything else, including an attempted open-redirect payload", () => {
  assert.equal(parseTripReturnTarget("trips"), "trips");
  assert.equal(parseTripReturnTarget(null), "trips");
  assert.equal(parseTripReturnTarget(""), "trips");
  assert.equal(parseTripReturnTarget("https://evil.example/phish"), "trips");
  assert.equal(parseTripReturnTarget("//evil.example"), "trips");
  assert.equal(parseTripReturnTarget("/operator"), "trips");
  assert.equal(parseTripReturnTarget("Operator"), "trips"); // case-sensitive, no fuzzy match
});

test("tripReturnPath builds a fixed, known route for each target — never an arbitrary one", () => {
  assert.equal(tripReturnPath("trips"), "/trips");
  assert.equal(tripReturnPath("operator"), "/operator");
});

// describeReleaseError is the one mapping both the production page and the
// operator home page render. Asserted against the real dictionaries so a
// refusal reason with no text in either language fails here rather than
// rendering an empty banner, which reads to an operator as "nothing
// happened".
test("describeReleaseError names an unapproved mix design in both languages, distinct from the generic state change", () => {
  for (const dict of [ar, en]) {
    const messages = dict.modules.production.releaseError;
    const text = describeReleaseError(messages, "MIX_NOT_APPROVED", undefined);
    assert.equal(text, messages.MIX_NOT_APPROVED);
    assert.ok(text && text.length > 0);
    assert.notEqual(text, messages.INVALID_STATE, "an unapproved recipe must not read as a transient state change the operator should just retry");
  }
});

test("describeReleaseError maps every release refusal the domain returns, and renders nothing for an unknown code", () => {
  const messages = en.modules.production.releaseError;
  assert.equal(describeReleaseError(messages, "INVALID_STATE", undefined), messages.INVALID_STATE);
  assert.equal(describeReleaseError(messages, "NOT_FOUND", undefined), messages.NOT_FOUND);
  assert.equal(describeReleaseError(messages, "NO_REMAINING_VOLUME", undefined), messages.NO_REMAINING_VOLUME);
  assert.equal(describeReleaseError(messages, "STORAGE_NOT_CONFIGURED", "Cement"), messages.STORAGE_NOT_CONFIGURED("Cement"));
  assert.equal(describeReleaseError(messages, undefined, undefined), null);
  assert.equal(describeReleaseError(messages, "SOMETHING_ELSE", undefined), null);
  assert.equal(describeReleaseError(messages, "toString", undefined), null, "a prototype key in a hand-edited URL must not resolve to anything");
});
