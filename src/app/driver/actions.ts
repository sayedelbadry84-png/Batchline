"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/session";
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

export async function uploadDeliveryPhoto(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const file = formData.get("photo");
  if (!tripId || !(file instanceof File) || file.size === 0) return;
  await requireOwnTrip(tripId);

  const buffer = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${buffer.toString("base64")}`;

  await prisma.trip.update({ where: { id: tripId }, data: { deliveryPhotoDataUrl: dataUrl } });
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
