"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

const NEXT_STATUS: Record<string, string> = {
  LOADING: "IN_TRANSIT",
  IN_TRANSIT: "ON_SITE",
  ON_SITE: "DISCHARGING",
};

export async function advanceTrip(formData: FormData) {
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
  const tripId = String(formData.get("tripId") ?? "");
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: { batchTicket: true } });
  if (!trip) return;

  await prisma.trip.update({
    where: { id: tripId },
    data: { status: "CLOSED", dischargeEnd: new Date(), volumeDeliveredM3: trip.batchTicket.volumeM3 },
  });
  await prisma.reservation.update({ where: { id: trip.batchTicket.reservationId }, data: { status: "DELIVERED" } });

  await logAudit({ module: "Fleet", recordId: tripId, field: "status", afterValue: "CLOSED", reasonCode: "TRIP_CLOSED_FULL_LOAD" });

  revalidatePath("/trips");
  revalidatePath("/reservations");
}

// Return & discount policy from the design spec: full waste past the drum
// timer window; no charge under the absorption threshold; partial credit
// above it (pending accountant approval) otherwise.
export async function closeTripWithReturn(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const returnedVolumeM3 = Number(formData.get("returnedVolumeM3") ?? 0);
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
      data: { tripId, returnedVolumeM3, minutesSinceBatch, disposition },
    }),
    prisma.reservation.update({
      where: { id: trip.batchTicket.reservationId },
      data: { status: "DELIVERED" },
    }),
  ]);

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
