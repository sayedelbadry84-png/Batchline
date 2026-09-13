// Shared backoff/dead-letter policy for this app's small retry-queue
// tables (PendingAutoRequisition, PendingBlobDeletion) — PL-R10-P2-03,
// tenth production-lifecycle review. A blind `orderBy: createdAt` let
// the oldest 200 permanently-failing rows starve every genuinely
// resolvable newer row forever, since every daily sweep re-selected the
// exact same rows. Capped exponential backoff moves a repeatedly-failing
// row's own next-eligible time later and later, so it naturally falls
// behind newer rows in `WHERE nextAttemptAt <= now() ORDER BY
// nextAttemptAt ASC` instead of permanently occupying a claim slot.
//
// 1h/2h/4h/... capped at 48h: the daily cron cadence (vercel.json) means
// anything past about a day already means "skip tomorrow's run too" for
// a genuinely struggling row — there is no value modeling finer-grained
// backoff than the schedule that actually drives retries.
const BASE_DELAY_MS = 60 * 60 * 1000;
const MAX_DELAY_MS = 48 * 60 * 60 * 1000;

// Roughly two weeks of consecutive daily failures: long enough that a
// real transient issue (a brief outage, a momentary lock timeout) never
// dead-letters, short enough that a truly permanent failure (a deleted
// material, a revoked credential) doesn't silently retry forever with
// nobody noticing.
export const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 14;

export function computeNextAttempt(attemptsSoFar: number): Date {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attemptsSoFar);
  return new Date(Date.now() + delay);
}
