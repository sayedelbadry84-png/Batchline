import { prisma } from "@/lib/prisma";

// A truck's current drum content isn't a stored field — it's derived from
// its own most recent CLOSED trip. If that trip returned material and it
// was later marked RECLAIMED (kept in the drum for reuse, not dumped) and
// nothing since has consumed it, that's what's physically sitting in the
// drum right now. Only offered for a matching mix — reusing leftover
// concrete under a different recipe isn't valid, so this is a hard
// filter, not a preference.
export async function getAvailableReclaimForTruck(
  truckId: string,
  mixId: string,
): Promise<{ drumReturnId: string; volumeM3: number } | null> {
  const lastTrip = await prisma.trip.findFirst({
    where: { truckId, status: "CLOSED" },
    orderBy: { createdAt: "desc" },
    select: {
      drumReturn: { select: { id: true, fate: true, consumedAt: true, returnedVolumeM3: true } },
      batchTicket: { select: { mixId: true } },
    },
  });
  const drumReturn = lastTrip?.drumReturn;
  if (!drumReturn || drumReturn.fate !== "RECLAIMED" || drumReturn.consumedAt) return null;
  if (lastTrip.batchTicket.mixId !== mixId) return null;
  return { drumReturnId: drumReturn.id, volumeM3: drumReturn.returnedVolumeM3 };
}
