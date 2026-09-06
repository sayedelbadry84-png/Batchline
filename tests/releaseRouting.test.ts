// Pure-logic tests for src/lib/releaseRouting.ts — no database, no
// Next.js request context, nothing to stub. RMR-R4-P2-01: the release
// actions used to concatenate a raw, form-supplied `returnPrefix` string
// straight into a redirect target, which is an open redirect for any
// authenticated caller who submits something other than the two values
// the UI itself ever sends. These functions replace that with a closed,
// server-derived allow-list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReturnTarget, releaseSuccessPath, releaseFailurePath, parseTripReturnTarget, tripReturnPath } from "../src/lib/releaseRouting";

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
