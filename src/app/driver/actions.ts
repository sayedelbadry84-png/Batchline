"use server";

import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  advanceTrip as advanceTripBase,
  closeTripFull as closeTripFullBase,
  closeTripWithReturn as closeTripWithReturnBase,
} from "@/app/(app)/trips/actions";

const COOKIE_NAME = "batchline_driver_id";

// No auth system yet (Phase 5) — the driver picks themselves once and the
// choice is remembered in a cookie, standing in for a real login.
export async function selectDriver(formData: FormData) {
  const driverId = String(formData.get("driverId") ?? "");
  if (!driverId) return;
  const store = await cookies();
  store.set(COOKIE_NAME, driverId, { path: "/", maxAge: 60 * 60 * 24 * 30 });
  redirect("/driver");
}

export async function switchDriver() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
  redirect("/driver");
}

export async function driverAdvanceTrip(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  await advanceTripBase(formData);
  revalidatePath(`/driver/trip/${tripId}`);
  revalidatePath("/driver");
}

export async function uploadDeliveryPhoto(formData: FormData) {
  const tripId = String(formData.get("tripId") ?? "");
  const file = formData.get("photo");
  if (!tripId || !(file instanceof File) || file.size === 0) return;

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

  await prisma.trip.update({ where: { id: tripId }, data: { deliverySignedBy: signedBy, deliverySignedAt: new Date() } });
  await closeTripWithReturnBase(formData);
  await logAudit({ module: "Fleet", recordId: tripId, afterValue: signedBy, reasonCode: "DELIVERY_CONFIRMED_WITH_RETURN" });

  revalidatePath("/driver");
  redirect("/driver");
}
