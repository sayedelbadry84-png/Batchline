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
export async function withSequentialNumber<T>(
  prefix: string,
  count: () => Promise<number>,
  attempt: (candidateNumber: string) => Promise<T>,
): Promise<T> {
  const year = new Date().getFullYear();
  for (let attemptIndex = 0; attemptIndex < 5; attemptIndex++) {
    const n = (await count()) + 1 + attemptIndex;
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
