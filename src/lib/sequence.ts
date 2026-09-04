import { Prisma } from "@prisma/client";

// Generates a globally-unique "PREFIX-YEAR-NNNN" number and passes it to
// `attempt`, retrying with the next number on a P2002 collision (two
// requests reading the same count before either commits). Extracted after
// BatchTicket.ticketNumber's own generation turned out to be scoped by
// plantId in its count while the column itself is globally unique — the
// FIRST ticket at any second plant always collided with whichever other
// plant already had "BT-<year>-0001" (see releaseTicketForReservation in
// production/actions.ts). `count` must therefore always count across
// EXACTLY the same set the target column's uniqueness covers — the retry
// loop is only a second line of defense against the residual
// count-then-insert race, not a fix for a mismatched count scope.
//
// `count` now receives the current calendar year's [start, end) range and
// is expected to filter its own query by it (typically on createdAt) — a
// plain unscoped count() genuinely breaks the moment the year rolls over:
// with 500 rows from last year already on file, the first row of the new
// year would compute n=501 and produce e.g. "BT-2027-0501" instead of
// restarting at "...-0001", since nothing about that number collides with
// anything (every existing row is "...-2026-...") to trip the retry loop
// at all. Filtering by year makes the count restart naturally each
// January the same way the "-YYYY-" segment in the number itself implies
// it always should have.
export async function withSequentialNumber<T>(
  prefix: string,
  count: (yearRange: { gte: Date; lt: Date }) => Promise<number>,
  attempt: (candidateNumber: string) => Promise<T>,
): Promise<T> {
  const year = new Date().getFullYear();
  const yearRange = { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
  for (let attemptIndex = 0; attemptIndex < 5; attemptIndex++) {
    const n = (await count(yearRange)) + 1 + attemptIndex;
    const candidate = `${prefix}-${year}-${String(n).padStart(4, "0")}`;
    try {
      return await attempt(candidate);
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
      // Someone else just took this number — loop and try the next one.
    }
  }
  throw new Error(`Could not allocate a unique ${prefix} number after 5 attempts.`);
}
