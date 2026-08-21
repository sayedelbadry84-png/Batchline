"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { isReservationFullyDelivered } from "@/lib/reservations";
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
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return;

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
  if (!trip) return;

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
  if (!trip) return;

  const now = new Date();
  const minutesSinceBatch = Math.round((now.getTime() - trip.batchTime.getTime()) / 60000);
  const plant = trip.batchTicket.plant;

  let disposition: string;
  if (minutesSinceBatch > plant.drumTimerLimitMinutes) {
    disposition = "FULL_WASTE";
  } else if (returnedVolumeM3 <= plant.returnAbsorptionThresholdM3) {
    disposition = "NO_CHARGE";
  } else {
    disposition = "PARTIAL_CREDIT";
  }

  const volumeDeliveredM3 =
    disposition === "FULL_WASTE" ? 0 : Math.max(0, trip.batchTicket.volumeM3 - returnedVolumeM3);

  await prisma.$transaction([
    prisma.trip.update({
      where: { id: tripId },
      data: { status: "CLOSED", dischargeEnd: now, volumeDeliveredM3 },
    }),
    prisma.drumReturn.create({
      data: { tripId, returnedVolumeM3, minutesSinceBatch, disposition, reasonCode, fate },
    }),
  ]);

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
