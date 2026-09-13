// Integration audit (2026-09-12): ordering and burst control for the two
// machine ingestion routes (SCADA silo readings, GPS truck pings).
//
// Both routes used to stamp `new Date()` — the moment the SERVER received
// the request — and write unconditionally by primary key. A ping delayed
// in transit therefore overwrote a newer one that had already landed, and
// was stamped with a fresh receipt time, so nothing about the stored row
// revealed that it held stale data. For a silo level that decides whether
// an auto-requisition fires, and for a truck position a dispatcher routes
// by, that is a correctness problem, not a cosmetic one.
//
// The fix is to order by when the reading was OBSERVED, and to let the
// database refuse an out-of-order write.

// How far ahead of the server a device's clock may be and still be
// believed. Some skew is normal on embedded gateways; a lot of it is
// either a broken clock or a device that would otherwise pin its own
// reading permanently into the future and block every real reading after
// it. Refusing is the safe direction: the device can resend.
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// Older than this and the reading is not worth applying to a live level or
// position at all — it describes a world that has moved on.
export const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;

export type ObservedAtResult =
  | { status: "OK"; observedAt: Date }
  | { status: "INVALID"; reason: string };

// `observedAt` is OPTIONAL on purpose: existing gateways do not send it,
// and a required field would take every one of them offline on deploy.
// Without it the receipt time is used, which reproduces exactly the
// previous behaviour for that device while newer devices get real
// ordering.
export function resolveObservedAt(raw: unknown, now: Date): ObservedAtResult {
  if (raw === undefined || raw === null) return { status: "OK", observedAt: now };
  if (typeof raw !== "string") return { status: "INVALID", reason: "observedAt must be an ISO-8601 string" };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { status: "INVALID", reason: "observedAt is not a valid ISO-8601 timestamp" };
  if (parsed.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) {
    return { status: "INVALID", reason: "observedAt is too far in the future — check the device clock" };
  }
  if (now.getTime() - parsed.getTime() > MAX_OBSERVATION_AGE_MS) {
    return { status: "INVALID", reason: "observedAt is older than the maximum accepted age" };
  }
  return { status: "OK", observedAt: parsed };
}

// A fixed-window burst guard, held in this process's memory.
//
// What it IS: a cheap stop for the common failure — one device stuck in a
// retry loop hammering the instance it is connected to. One Map lookup per
// request, no database write, which matters because the whole point of
// this audit pass was removing a per-request write from this path.
//
// What it is NOT: a distributed rate limit. On serverless each instance
// has its own memory, so a device spread across N instances gets up to N
// windows. Anything stronger needs shared state and therefore a write per
// request — the cost this deliberately avoids. Stated plainly so nobody
// mistakes this for a guarantee it does not provide.
const windows = new Map<string, { count: number; resetAt: number }>();

export function allowTelemetryBurst(
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): boolean {
  const existing = windows.get(key);
  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep so a long-lived instance cannot accumulate a
    // window per device id forever.
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
    }
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

export function __resetTelemetryBurstForTesting() {
  windows.clear();
}

// One reading every two seconds sustained, per device, is far above any
// real SCADA or GPS cadence and far below what a retry loop produces.
export const TELEMETRY_BURST_LIMIT = 30;
export const TELEMETRY_BURST_WINDOW_MS = 60 * 1000;
