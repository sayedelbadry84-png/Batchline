"use server";

import { getCurrentUser, requireRole, requireActionPermission } from "@/lib/session";
import { effectiveSiteId } from "@/lib/siteScope";
import {
  advanceTripState,
  closeTripFullForId,
  closeTripWithReturnForId,
  setDrumReturnFateForId,
  type AdvanceableTripStatus,
  type AdvanceTripResult,
  type CloseTripFullResult,
  type CloseTripWithReturnResult,
  type SetDrumReturnFateResult,
} from "@/lib/tripLifecycle";
import { revalidatePath } from "next/cache";

const ADVANCEABLE_STATUSES: readonly AdvanceableTripStatus[] = ["LOADING", "IN_TRANSIT", "ON_SITE"];

// Every non-OK outcome below used to be a silent no-op — a rejected
// advance/close/fate change looked identical to the button simply not
// having been pressed (PL-R3-P2-01, third production-lifecycle review,
// repeating PL-R2-P2-01/PL-P2-01 from the two reviews before it). Each
// action here is now shaped for React's useActionState (prevState,
// formData) => state — mirrors CompleteBatchActionState's own established
// convention (production/actions.ts) — and returns the domain result's
// OWN typed status directly, so a Client Component can render exactly
// why a request was refused instead of nothing happening. "MISSING_FIELDS"
// covers the client-side parse guard that used to be a bare `return`.
// Nothing here catches anything — an unrecognized/unknown exception
// still propagates rather than being swallowed into a validation-looking
// state.

export type AdvanceTripActionState = { status: AdvanceTripResult["status"] } | { status: "MISSING_FIELDS" } | null;

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
export async function advanceTrip(_prevState: AdvanceTripActionState, formData: FormData): Promise<AdvanceTripActionState> {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  // The status the UI believed this trip was in when the button was
  // rendered — never trusted as authority on its own (see
  // advanceTripState's own comment, PL-R2-P1-01), just an optimistic-
  // concurrency token compared against the freshly locked row. An
  // unrecognized/missing value can never match a real trip status, so it
  // naturally falls through to STALE_STATE rather than needing its own
  // guard here.
  const expectedStatus = String(formData.get("expectedStatus") ?? "");
  if (!tripId || !ADVANCEABLE_STATUSES.includes(expectedStatus as AdvanceableTripStatus)) return { status: "MISSING_FIELDS" };

  const result = await advanceTripState(tripId, expectedStatus as AdvanceableTripStatus, {
    allowedSiteId: effectiveSiteId(user),
    requireOwnDriverEmployeeId: user!.role === "DRIVER" ? user!.employeeId : null,
    actorId: user!.id,
    actorRole: user!.role,
  });

  revalidatePath("/trips");
  return result;
}

export type CloseTripFullActionState = { status: CloseTripFullResult["status"] } | { status: "MISSING_FIELDS" } | null;

// Full load delivered, nothing returned — close the trip outright.
export async function closeTripFull(_prevState: CloseTripFullActionState, formData: FormData): Promise<CloseTripFullActionState> {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  if (!tripId) return { status: "MISSING_FIELDS" };
  const deliverySignedBy = String(formData.get("deliverySignedBy") ?? "").trim() || null;

  const result = await closeTripFullForId(tripId, {
    allowedSiteId: effectiveSiteId(user),
    requireOwnDriverEmployeeId: user!.role === "DRIVER" ? user!.employeeId : null,
    actorId: user!.id,
    actorRole: user!.role,
    deliverySignedBy,
  });

  revalidatePath("/trips");
  revalidatePath("/reservations");
  return result;
}

export type CloseTripWithReturnActionState = { status: CloseTripWithReturnResult["status"] } | { status: "MISSING_FIELDS" } | null;

export async function closeTripWithReturn(_prevState: CloseTripWithReturnActionState, formData: FormData): Promise<CloseTripWithReturnActionState> {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN", "DRIVER"]);

  const tripId = String(formData.get("tripId") ?? "");
  const returnedVolumeM3 = Number(formData.get("returnedVolumeM3") ?? 0);
  const reasonCode = String(formData.get("reasonCode") ?? "").trim() || null;
  const fate = String(formData.get("fate") ?? "").trim() || null;
  if (!tripId) return { status: "MISSING_FIELDS" };
  const deliverySignedBy = String(formData.get("deliverySignedBy") ?? "").trim() || null;

  const result = await closeTripWithReturnForId(tripId, {
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
  return result;
}

export type SetDrumReturnFateActionState = { status: SetDrumReturnFateResult["status"] } | { status: "MISSING_FIELDS" } | null;

// A return can be logged at close time without knowing yet what will
// actually happen to the concrete sitting in the drum (fate is optional
// on closeTripWithReturn above) — this closes that loop once someone
// decides: fed back into another batch (RECLAIMED, the same concept
// RhinoMaster's "redispatched" status names) or dumped (DUMPED). Never
// full waste can be marked reclaimed — there's nothing left to reuse.
export async function markDrumReturnFate(_prevState: SetDrumReturnFateActionState, formData: FormData): Promise<SetDrumReturnFateActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "trips", "setDrumReturnFate");

  const id = String(formData.get("id") ?? "");
  const fate = String(formData.get("fate") ?? "");
  if (!id || !fate) return { status: "MISSING_FIELDS" };

  const result = await setDrumReturnFateForId(id, fate, { allowedSiteId: effectiveSiteId(user), actorId: user!.id, actorRole: user!.role });

  revalidatePath("/trips");
  revalidatePath("/reports");
  return result;
}
