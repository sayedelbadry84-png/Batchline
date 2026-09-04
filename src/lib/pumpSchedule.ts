import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

// A pump job's real duration isn't captured anywhere at booking time —
// PumpAssignment only has a single scheduledStart instant, and
// billedHours is filled in after the job from actual site time, not
// known in advance. This is a deliberately generous placeholder estimate
// used ONLY to detect double-booking the same physical pump (and its
// crew), never for billing: long enough to catch same-pump bookings that
// would obviously clash in practice (loading, travel, setup, the pour
// itself, wash-out), short enough not to flag two genuinely sequential
// jobs on the same pump the same day as conflicting.
export const DEFAULT_PUMP_JOB_HOURS = 3;

export function pumpJobWindow(scheduledStart: Date): { start: Date; end: Date } {
  return { start: scheduledStart, end: new Date(scheduledStart.getTime() + DEFAULT_PUMP_JOB_HOURS * 60 * 60 * 1000) };
}

// True if this pump has no other non-cancelled assignment whose estimated
// job window overlaps the requested one — nothing before this checked
// that the same physical pump (and whatever crew is riding with it)
// isn't already committed elsewhere at the same time. excludeAssignmentId
// lets a reschedule check against every OTHER booking without always
// conflicting with itself.
export async function isPumpAvailable(db: Db, pumpId: string, scheduledStart: Date, excludeAssignmentId?: string): Promise<boolean> {
  const { start, end } = pumpJobWindow(scheduledStart);
  const existing = await db.pumpAssignment.findMany({
    where: {
      pumpId,
      status: { not: "CANCELLED" },
      ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}),
    },
    select: { scheduledStart: true },
  });
  return !existing.some((a) => {
    const other = pumpJobWindow(a.scheduledStart);
    return other.start < end && other.end > start;
  });
}
