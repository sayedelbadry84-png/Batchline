"use server";

import { getCurrentUser, requireRole, requireActionPermission } from "@/lib/session";
import { effectiveSiteId } from "@/lib/siteScope";
import { advanceTripState, closeTripFullForId, closeTripWithReturnForId, setDrumReturnFateForId } from "@/lib/tripLifecycle";
import { revalidatePath } from "next/cache";

// DRIVER is allowed on all three trip-close/advance actions below — the
// driver app's wrappers (see src/app/driver/actions.ts) call straight
// into these, and requireOwnTrip already verifies the trip belongs to
// that driver before getting here. But that's a check made by the
// CALLER, not this function — a Server Action's own reference is present
// in the client bundle of any page that imports it, direct or not, so a
// DRIVER session must never be trusted to have arrived only through that
// wrapper. Every domain call below re-passes requireOwnDriverEmployeeId
// so the actual domain function re-verifies it fresh, inside its own row
// lock — PLANT_OPERATOR/ADMIN may act on any in-scope trip, but a DRIVER
// may only ever advance/close their own.
export async function advanceTrip(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  if (!tripId) return;

  await advanceTripState(tripId, {
    allowedSiteId: effectiveSiteId(user),
    requireOwnDriverEmployeeId: user!.role === "DRIVER" ? user!.employeeId : null,
    actorId: user!.id,
    actorRole: user!.role,
  });

  revalidatePath("/trips");
}

// Full load delivered, nothing returned — close the trip outright.
export async function closeTripFull(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  if (!tripId) return;
  const deliverySignedBy = String(formData.get("deliverySignedBy") ?? "").trim() || null;

  await closeTripFullForId(tripId, {
    allowedSiteId: effectiveSiteId(user),
    requireOwnDriverEmployeeId: user!.role === "DRIVER" ? user!.employeeId : null,
    actorId: user!.id,
    actorRole: user!.role,
    deliverySignedBy,
  });

  revalidatePath("/trips");
  revalidatePath("/reservations");
}

export async function closeTripWithReturn(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  const returnedVolumeM3 = Number(formData.get("returnedVolumeM3") ?? 0);
  const reasonCode = String(formData.get("reasonCode") ?? "").trim() || null;
  const fate = String(formData.get("fate") ?? "").trim() || null;
  if (!tripId) return;
  const deliverySignedBy = String(formData.get("deliverySignedBy") ?? "").trim() || null;

  await closeTripWithReturnForId(tripId, {
    allowedSiteId: effectiveSiteId(user),
    requireOwnDriverEmployeeId: user!.role === "DRIVER" ? user!.employeeId : null,
    actorId: user!.id,
    actorRole: user!.role,
    returnedVolumeM3,
    reasonCode,
    fate,
    deliverySignedBy,
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

  await setDrumReturnFateForId(id, fate, { allowedSiteId: effectiveSiteId(user), actorId: user!.id, actorRole: user!.role });

  revalidatePath("/trips");
  revalidatePath("/reports");
}
