"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/session";
import { uploadFile, deleteFile } from "@/lib/blob";
import { notifyRoles } from "@/lib/notify";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  advanceTrip as advanceTripBase,
  closeTripFull as closeTripFullBase,
  closeTripWithReturn as closeTripWithReturnBase,
} from "@/app/(app)/trips/actions";

// Every driver action is scoped to the logged-in session's own Employee
// record — a driver can only touch their own trips, not one assigned to
// someone else, even if they guess another trip's id.
async function requireOwnTrip(tripId: string) {
  const user = await getCurrentUser();
  if (!user || user.role !== "DRIVER" || !user.employeeId) {
    throw new Error("Not authenticated as a driver.");
  }
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip || trip.driverId !== user.employeeId) {
    throw new Error("This trip isn't assigned to you.");
  }
}

export async function driverAdvanceTrip(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  await requireOwnTrip(tripId);
  await advanceTripBase(formData);
  revalidatePath(`/driver/trip/${tripId}`);
  revalidatePath("/driver");
}

const DELAY_REASONS = new Set(["TRAFFIC", "BREAKDOWN", "WEATHER", "ACCIDENT", "OTHER"]);

// Real push (see src/lib/push.ts, via notify()) to dispatch the instant a
// driver reports a delay — the whole point being that the office finds
// out before the customer has to call and ask where their delivery is.
export async function reportTripDelay(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!tripId || !DELAY_REASONS.has(reason)) return;
  await requireOwnTrip(tripId);

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { batchTicket: { select: { ticketNumber: true, reservation: { select: { reservationNumber: true, project: { select: { name: true } } } } } } },
  });
  if (!trip) return;

  await prisma.tripDelayReport.create({ data: { tripId, reason, note } });

  await logAudit({ module: "Fleet", recordId: tripId, afterValue: reason, reasonCode: "TRIP_DELAY_REPORTED" });
  await notifyRoles(["PLANT_OPERATOR", "ADMIN"], {
    title: trip.batchTicket.reservation.reservationNumber,
    body: `${trip.batchTicket.ticketNumber} — ${trip.batchTicket.reservation.project.name}: ${reason}${note ? ` — ${note}` : ""}`,
    link: "/trips",
    module: "Fleet",
  });

  revalidatePath(`/driver/trip/${tripId}`);
  revalidatePath("/trips");
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Magic-number prefixes for the formats a phone camera/browser actually
// produces here — checked against the file's real bytes, not the
// client-reported MIME type or filename (both fully attacker-controlled),
// so a renamed/relabeled non-image can't ride uploadFile's contentType
// straight into private storage.
const PHOTO_SIGNATURES: { ext: string; bytes: number[] }[] = [
  { ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"; WEBP marker follows at offset 8, checked below
];

async function detectPhotoExtension(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  for (const sig of PHOTO_SIGNATURES) {
    if (sig.bytes.every((b, i) => head[i] === b)) {
      if (sig.ext === "webp" && !(head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50)) continue;
      return sig.ext;
    }
  }
  return null;
}

export async function uploadDeliveryPhoto(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const file = formData.get("photo");
  if (!tripId || !(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_PHOTO_BYTES) return;
  const ext = await detectPhotoExtension(file);
  if (!ext) return;
  await requireOwnTrip(tripId);
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { deliveryPhotoUrl: true } });

  const url = await uploadFile(`delivery-photos/${tripId}.${ext}`, file);

  await prisma.trip.update({ where: { id: tripId }, data: { deliveryPhotoUrl: url } });
  // A re-take replaces the row's own URL immediately above — clean up the
  // old blob after so a driver retrying the photo doesn't leave orphaned
  // files behind in storage.
  if (trip?.deliveryPhotoUrl) await deleteFile(trip.deliveryPhotoUrl);

  await logAudit({ module: "Fleet", recordId: tripId, reasonCode: "DELIVERY_PHOTO_CAPTURED" });

  revalidatePath(`/driver/trip/${tripId}`);
}

export async function confirmDeliveryFull(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const signedBy = String(formData.get("signedBy") ?? "").trim();
  if (!tripId || !signedBy) return;
  await requireOwnTrip(tripId);

  await prisma.trip.update({ where: { id: tripId }, data: { deliverySignedBy: signedBy, deliverySignedAt: new Date() } });
  await closeTripFullBase(formData);
  await logAudit({ module: "Fleet", recordId: tripId, afterValue: signedBy, reasonCode: "DELIVERY_CONFIRMED_FULL" });

  revalidatePath("/driver");
  redirect("/driver");
}

export async function confirmDeliveryWithReturn(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const signedBy = String(formData.get("signedBy") ?? "").trim();
  if (!tripId || !signedBy) return;
  await requireOwnTrip(tripId);

  await prisma.trip.update({ where: { id: tripId }, data: { deliverySignedBy: signedBy, deliverySignedAt: new Date() } });
  await closeTripWithReturnBase(formData);
  await logAudit({ module: "Fleet", recordId: tripId, afterValue: signedBy, reasonCode: "DELIVERY_CONFIRMED_WITH_RETURN" });

  revalidatePath("/driver");
  redirect("/driver");
}
