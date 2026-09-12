import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, type CurrentUser } from "@/lib/session";
import { getActiveSiteId } from "@/lib/siteScope";
import { createDateFormatters, resolveTimeZone, type DateFormatters } from "@/lib/datetime";

/**
 * Resolves which plant's clock a page should render its timestamps in.
 * See src/lib/datetime.ts for why it is the plant's clock and not the
 * viewer's device.
 *
 * The chain follows the same display-scope rules the rest of the app
 * already uses, deliberately reusing getActiveSiteId rather than
 * inventing a second notion of "which plant am I looking at":
 *
 *   1. A non-admin is pinned to one station, so its own timezone wins.
 *   2. An ADMIN viewing a specific factory gets that factory's clock —
 *      a head-office user switching to the Riyadh site should read
 *      Riyadh times, not Cairo ones.
 *   3. Otherwise (ADMIN with no site picked, or a site whose stations
 *      were all removed) the schema default stands.
 *
 * Every step fails soft to the fallback: a page must not 500 because a
 * station row is missing or its timezone was mistyped.
 */
async function resolveDisplayTimeZone(user: CurrentUser | null): Promise<string> {
  if (user?.plant?.timezone) return resolveTimeZone(user.plant.timezone);

  const siteId = await getActiveSiteId(user);
  if (!siteId) return resolveTimeZone(null);

  // Stations inside one factory share a city, so any ACTIVE one answers
  // the question; ordering by createdAt just makes the choice stable
  // rather than dependent on Postgres' row order.
  const plant = await prisma.plant
    .findFirst({
      where: { siteId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { timezone: true },
    })
    .catch(() => null);
  return resolveTimeZone(plant?.timezone);
}

/**
 * Memoized per request by React `cache`, so the dozens of call sites on a
 * page like reports/page.tsx share one lookup instead of issuing one
 * query each.
 */
export const getDisplayTimeZone = cache(async (): Promise<string> => {
  const user = await getCurrentUser().catch(() => null);
  return resolveDisplayTimeZone(user);
});

/**
 * What pages actually call. Returns plain functions bound to the resolved
 * zone, so a call site reads `f.dateTime(ticket.batchCompletedAt)`.
 *
 * NOT serializable across the RSC boundary — a Client Component takes
 * `timeZone` as a string prop and builds its own with
 * `createDateFormatters`. Passing this object to one is the same defect
 * commit 5776765 removed from FleetMap.
 */
export const getDateFormatters = cache(async (): Promise<DateFormatters> => {
  return createDateFormatters(await getDisplayTimeZone());
});
