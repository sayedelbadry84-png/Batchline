import type { ReplayOutcome } from "@/lib/offlineQueue";
import type { RecordActualFieldResult } from "@/app/(app)/production/actions";

// PL-R15-P2-01, fifteenth production-lifecycle review: the offline
// replay handler's own result-to-outcome mapping, lifted out of
// OfflineSyncBanner.tsx so the real logic — not a paraphrase of it
// living inside a test's fake handler — is what the tests exercise.
//
// The banner still owns the transport (build the FormData, call the
// Server Action); everything that DECIDES an outcome from the server's
// typed answer lives here, has no browser or server dependency, and is
// unit-testable in plain node:test.

// Does the raw text this queue item is carrying denote the same
// measurement the server currently holds?
//
// PL-R15-P2-01: the previous check was `String(result.currentValue) ===
// fields.value`, which compares TEXT. The queue stores exactly what the
// operator typed, and an HTML number input happily keeps trailing or
// leading zeros — so a reading entered as "12.50" and accepted by the
// server (which parses it to 12.5 before writing) came back as
// currentValue 12.5, stringified to "12.5", compared unequal to "12.50",
// and the operator's OWN already-applied reading was dead-lettered as a
// conflict that never happened. The server parses the value with
// Number() before writing it (recordActualField in production/actions.ts),
// so parsing it the same way here is what makes the two sides agree.
//
// Deliberately strict about what counts as a reading at all: a blank or
// whitespace-only string, a non-numeric string, ±Infinity, or NaN is
// never "the value the server holds" — those must keep flowing down the
// genuine-conflict path rather than silently settling an item.
export function sameFiniteReading(raw: string | undefined, current: number | null): boolean {
  if (current === null || raw === undefined || raw.trim() === "") return false;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed === current;
}

// Maps recordActualField's own typed result to a ReplayOutcome — OK is
// the only unconditional APPLIED outcome; every other typed status is
// REJECTED (the business write was genuinely refused, replaying it again
// would refuse it again forever); a thrown exception (still offline, a
// real transport error) never reaches here at all — flushQueue's own
// try/catch treats that as RETRYABLE.
//
// PL-R14-P2-03, fourteenth review: a STALE_READING whose current server
// value IS the value we just sent means this exact reading already
// applied — almost always THIS client's own earlier attempt, whose local
// settlement failed to save. Treating it as a conflict dead-lettered the
// operator's own accepted reading and asked them to re-enter a number the
// database already held. The in-memory reconciliation in offlineQueue.ts
// only covers one session; this covers a reload, another tab, or another
// device, because it is decided from the server's own response. Either
// way the outcome is the same: the queued value is what the server holds,
// so the item is settled at the server's version.
export function toReplayOutcome(result: RecordActualFieldResult, fields: Record<string, string>): ReplayOutcome {
  // PL-R12-P1-01, twelfth review: the version is returned to flushQueue
  // rather than published from inside the handler. Publishing there fired
  // BEFORE the settlement was durably stored — and before it was known
  // whether this replay's own generation was still the current one — so a
  // superseded or unstored replay could still tell the mounted field
  // "saved, here is your new version".
  if (result.status === "OK") return { status: "APPLIED", version: result.version };
  if (result.status === "STALE_READING" && sameFiniteReading(fields.value, result.currentValue)) {
    return { status: "APPLIED", version: result.currentVersion };
  }
  return { status: "REJECTED", reason: result.status };
}
