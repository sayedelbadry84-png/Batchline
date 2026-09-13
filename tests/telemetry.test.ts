// Integration audit (2026-09-12): the ordering and burst rules for the two
// machine ingestion routes. Pure logic, no database — deliberately, since
// these decisions are made before any row is touched and the clock-skew
// cases are impossible to stage against a live gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveObservedAt,
  allowTelemetryBurst,
  __resetTelemetryBurstForTesting,
  MAX_CLOCK_SKEW_MS,
  MAX_OBSERVATION_AGE_MS,
} from "../src/lib/telemetry";

const now = new Date("2026-09-12T12:00:00.000Z");

test("a device that sends no observedAt keeps the previous behaviour", () => {
  // Backward compatibility is the point: requiring the field would take
  // every existing gateway offline on deploy.
  assert.deepEqual(resolveObservedAt(undefined, now), { status: "OK", observedAt: now });
  assert.deepEqual(resolveObservedAt(null, now), { status: "OK", observedAt: now });
});

test("a valid device timestamp is used instead of the receipt time", () => {
  const observed = resolveObservedAt("2026-09-12T11:59:30.000Z", now);
  assert.equal(observed.status, "OK");
  if (observed.status === "OK") assert.equal(observed.observedAt.toISOString(), "2026-09-12T11:59:30.000Z");
});

test("a clock far ahead of the server is refused, not stored", () => {
  // This is the case that would otherwise be permanent: a reading stamped
  // in the future pins the row and every real reading after it is refused
  // as older. Refusing at the door is the only recoverable direction.
  const far = new Date(now.getTime() + MAX_CLOCK_SKEW_MS + 1000).toISOString();
  assert.equal(resolveObservedAt(far, now).status, "INVALID");
  // Ordinary skew inside the tolerance is still accepted.
  const slight = new Date(now.getTime() + MAX_CLOCK_SKEW_MS - 1000).toISOString();
  assert.equal(resolveObservedAt(slight, now).status, "OK");
});

test("an observation older than the accepted age is refused", () => {
  const ancient = new Date(now.getTime() - MAX_OBSERVATION_AGE_MS - 1000).toISOString();
  assert.equal(resolveObservedAt(ancient, now).status, "INVALID");
});

test("anything that is not an ISO timestamp is refused", () => {
  for (const bad of ["", "yesterday", "2026-13-45T00:00:00Z", 1757664000000, {}, []]) {
    assert.equal(resolveObservedAt(bad, now).status, "INVALID", `${JSON.stringify(bad)} must not be accepted`);
  }
});

test("a device in a retry loop is cut off, and a different device is unaffected", () => {
  __resetTelemetryBurstForTesting();
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(allowTelemetryBurst("gps:key1:device-a", t, 5, 60_000), true, `request ${i + 1} is within the limit`);
  }
  assert.equal(allowTelemetryBurst("gps:key1:device-a", t, 5, 60_000), false, "the sixth in the window is refused");
  assert.equal(allowTelemetryBurst("gps:key1:device-b", t, 5, 60_000), true, "a different device has its own window");
  assert.equal(allowTelemetryBurst("gps:key2:device-a", t, 5, 60_000), true, "so does the same device under a different key");

  // The window is fixed, not sliding: once it rolls over the device is
  // allowed again rather than being locked out permanently.
  assert.equal(allowTelemetryBurst("gps:key1:device-a", t + 60_001, 5, 60_000), true);
});
