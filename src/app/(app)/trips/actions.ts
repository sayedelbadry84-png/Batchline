"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole, requireActionPermission } from "@/lib/session";
import { isReservationFullyDelivered } from "@/lib/reservations";
import { effectiveSiteId, isPlantInScope } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

const NEXT_STATUS: Record<string, string> = {
  LOADING: "IN_TRANSIT",
  IN_TRANSIT: "ON_SITE",
  ON_SITE: "DISCHARGING",
};

export async function advanceTrip(formData: FormData) {
  // DRIVER is allowed here too — the driver app's wrappers (see
  // src/app/driver/actions.ts) call straight into these three functions,
  // and requireOwnTrip already verified the trip belongs to that driver
  // before we get here; a plain Trips-page call never carries a DRIVER
  // session in the first place.
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { batchTicket: { select: { plantId: true } } } });
  if (!trip) return;
  if (!(await isPlantInScope(trip.batchTicket.plantId, effectiveSiteId(user)))) return;

  const next = NEXT_STATUS[trip.status];
  if (!next) return;

  const timestampField =
    next === "IN_TRANSIT" ? "departTime" : next === "ON_SITE" ? "arriveTime" : "dischargeStart";

  await prisma.trip.update({
    where: { id: tripId },
    data: { status: next, [timestampField]: new Date() },
  });

  await logAudit({ module: "Fleet", recordId: tripId, field: "status", afterValue: next, reasonCode: "TRIP_ADVANCED" });

  revalidatePath("/trips");
}

// Full load delivered, nothing returned — close the trip outright.
export async function closeTripFull(formData: FormData) {
  // DRIVER allowed — see the note on advanceTrip above.
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { batchTicket: true } });
  if (!trip || trip.status === "CLOSED") return;
  if (!(await isPlantInScope(trip.batchTicket.plantId, effectiveSiteId(user)))) return;

  await prisma.trip.update({
    where: { id: tripId },
    data: { status: "CLOSED", dischargeEnd: new Date(), volumeDeliveredM3: trip.batchTicket.volumeM3 },
  });

  // Only the reservation's LAST truck load flips it to DELIVERED — a split
  // load isn't done just because one of its many trips closed.
  if (await isReservationFullyDelivered(trip.batchTicket.reservationId)) {
    await prisma.reservation.update({ where: { id: trip.batchTicket.reservationId }, data: { status: "DELIVERED" } });
  }

  await logAudit({ module: "Fleet", recordId: tripId, field: "status", afterValue: "CLOSED", reasonCode: "TRIP_CLOSED_FULL_LOAD" });

  revalidatePath("/trips");
  revalidatePath("/reservations");
}

// Return & discount policy from the design spec: full waste past the drum
// timer window; no charge under the absorption threshold; partial credit
// above it (pending accountant approval) otherwise.
export async function closeTripWithReturn(formData: FormData) {
  // DRIVER allowed — see the note on advanceTrip above.
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  const returnedVolumeM3 = Number(formData.get("returnedVolumeM3") ?? 0);
  const reasonCode = String(formData.get("reasonCode") ?? "").trim() || null;
  const fate = String(formData.get("fate") ?? "").trim() || null;
  if (!tripId || returnedVolumeM3 <= 0) return;

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { batchTicket: { include: { plant: true } } },
  });
  if (!trip || trip.status === "CLOSED") return;
  if (!(await isPlantInScope(trip.batchTicket.plantId, effectiveSiteId(user)))) return;

  const now = new Date();
  const minutesSinceBatch = Math.round((now.getTime() - trip.batchTime.getTime()) / 60000);
  const plant = trip.batchTicket.plant;

  // A load rejected on quality grounds (bad slump, contamination, etc.) is
  // the plant's own failure, not the customer's — never charge for it
  // regardless of how long it sat in the drum, unlike every other return
  // reason below where the drum timer is what actually matters.
  let disposition: string;
  if (reasonCode === "QUALITY_REJECTED") {
    disposition = "NO_CHARGE";
  } else if (minutesSinceBatch > plant.drumTimerLimitMinutes) {
    disposition = "FULL_WASTE";
  } else if (returnedVolumeM3 <= plant.returnAbsorptionThresholdM3) {
    disposition = "NO_CHARGE";
  } else {
    disposition = "PARTIAL_CREDIT";
  }

  // Delivered/billed volume is reduced ONLY when the return reason is a
  // quality rejection — the plant's own failure to produce a load the
  // customer could use. Every other reason (over-ordered, customer
  // cancelled, site not ready, access blocked, traffic delay, other)
  // still bills the FULL ticket volume regardless of disposition — even a
  // FULL_WASTE return, since disposition tracks what happened to the
  // returned concrete itself (dumped/reclaimed/no-charge/credited), not
  // whether the customer owes for what left the plant. The customer is
  // responsible for the load either way unless we're the ones who failed
  // to deliver a usable one.
  const volumeDeliveredM3 =
    reasonCode === "QUALITY_REJECTED" ? Math.max(0, trip.batchTicket.volumeM3 - returnedVolumeM3) : trip.batchTicket.volumeM3;

  await prisma.$transaction(async (tx) => {
    await tx.trip.update({
      where: { id: tripId },
      data: { status: "CLOSED", dischargeEnd: now, volumeDeliveredM3 },
    });
    const drumReturn = await tx.drumReturn.create({
      data: { tripId, returnedVolumeM3, minutesSinceBatch, disposition, reasonCode, fate },
    });
    // A quality rejection needs a formal, approvable incident record — not
    // just the billing reduction above — since "approved by Quality" is a
    // real state transition someone has to sign off on, distinct from
    // whether the customer was charged for the load.
    if (reasonCode === "QUALITY_REJECTED") {
      await tx.wasteIncidentMemo.create({
        data: {
          drumReturnId: drumReturn.id,
          batchTicketId: trip.batchTicketId,
          wastedVolumeM3: returnedVolumeM3,
          reasonCode,
        },
      });
    }
  });

  // Only the reservation's LAST truck load flips it to DELIVERED — a split
  // load isn't done just because one of its many trips closed.
  if (await isReservationFullyDelivered(trip.batchTicket.reservationId)) {
    await prisma.reservation.update({
      where: { id: trip.batchTicket.reservationId },
      data: { status: "DELIVERED" },
    });
  }

  await logAudit({
    module: "Fleet",
    recordId: tripId,
    field: "drumReturn",
    afterValue: `${returnedVolumeM3} m3 @ ${minutesSinceBatch}min`,
    reasonCode: disposition,
    role: disposition === "PARTIAL_CREDIT" ? "ACCOUNTANT" : "QUALITY_SUPERVISOR",
  });

  revalidatePath("/trips");
  revalidatePath("/reservations");
}

// A return can be logged at close time without knowing yet what will
// actually happen to the concrete sitting in the drum (fate is optional
// on closeTripWithReturn above) — this closes that loop once someone
// decides: fed back into another batch (RECLAIMED, the same concept
// RhinoMaster's "redispatched" status names) or dumped (DUMPED). Never
// full waste can be marked reclaimed — there's nothing left to reuse.
export async function markDrumReturnFate(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "trips", "setDrumReturnFate");

  const id = String(formData.get("id") ?? "");
  const fate = String(formData.get("fate") ?? "");
  if (!id || !fate) return;

  const drumReturn = await prisma.drumReturn.findUnique({ where: { id }, include: { trip: { include: { batchTicket: { select: { plantId: true } } } } } });
  if (!drumReturn || drumReturn.disposition === "FULL_WASTE") return;
  if (!(await isPlantInScope(drumReturn.trip.batchTicket.plantId, effectiveSiteId(user)))) return;

  await prisma.drumReturn.update({ where: { id }, data: { fate } });

  await logAudit({
    module: "Fleet",
    recordId: id,
    field: "fate",
    afterValue: fate,
    reasonCode: "DRUM_RETURN_FATE_SET",
  });

  revalidatePath("/trips");
  revalidatePath("/reports");
}
