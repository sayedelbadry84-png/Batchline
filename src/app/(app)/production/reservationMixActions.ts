"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import {
  saveReservationMixRevision as saveRevisionDomain,
  cancelActiveReservationMixRevision as cancelRevisionDomain,
  type ComponentInput,
} from "@/lib/reservationMixRevisions";
import { revalidatePath } from "next/cache";

// Thin Server Action wrappers around reservationMixRevisions.ts's domain
// functions — the actual claim/create/supersede logic lives there (pure,
// no session/formData access, callable from tests directly), same split
// as every other feature this session (batchCompletion.ts,
// shortageOverrideRequests.ts, ...). These wrappers only handle
// permission/scope checks and parsing formData — the domain functions
// themselves now write their own AuditEvent row atomically, inside the
// same transaction as the revision change (RMR-P2-04; this file used to
// do it afterward, as a separate, later call, which meant a failed audit
// write could leave a recipe change on file with no record of it).

async function requireReservationMixEditScope(reservationId: string) {
  const user = await getCurrentUser();
  try {
    await requireActionPermission(user, "production", "editReservationMix");
  } catch (e) {
    // No existing pattern in this codebase logs a permission denial (the
    // rest of the app just lets the throw propagate to Next.js's own
    // error boundary) — this feature specifically asked for unauthorized
    // attempts to be recorded, so this is a deliberately new addition,
    // not a retrofit of something already done elsewhere.
    await logAudit({
      module: "Production",
      recordId: reservationId,
      reasonCode: "UNAUTHORIZED_MIX_EDIT_ATTEMPT",
      afterValue: user?.email ?? "unknown",
    });
    throw e;
  }

  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { siteId: true, mixId: true } });
  if (!reservation) return { user, reservation: null };
  if (!isSiteInScope(reservation.siteId, effectiveSiteId(user))) {
    // A cross-site attempt against a REAL reservation ID is recorded the
    // same way a straight permission denial is (RMR-P2-04) — the
    // response to the caller stays NOT_FOUND either way (never revealing
    // whether the id exists or merely belongs to another site), only the
    // internal record distinguishes the two.
    await logAudit({
      module: "Production",
      recordId: reservationId,
      reasonCode: "UNAUTHORIZED_MIX_EDIT_ATTEMPT",
      afterValue: user?.email ?? "unknown",
    });
    return { user, reservation: null };
  }
  return { user, reservation };
}

export type SaveReservationMixActionState = {
  status:
    | "OK"
    | "NOT_FOUND"
    | "INVALID_STATE"
    | "NO_COMPONENTS"
    | "DUPLICATE_MATERIAL"
    | "INVALID_QUANTITY"
    | "MATERIAL_NOT_FOUND"
    | "UNSUPPORTED_MATERIAL_TYPE"
    | "MISSING_SPECIFIC_GRAVITY"
    | "INVALID_REASON";
  detail?: string;
} | null;

export async function saveReservationMixRevisionAction(_prevState: SaveReservationMixActionState, formData: FormData): Promise<SaveReservationMixActionState> {
  const reservationId = String(formData.get("reservationId") ?? "");
  if (!reservationId) return { status: "NOT_FOUND" };

  const { user, reservation } = await requireReservationMixEditScope(reservationId);
  if (!reservation) return { status: "NOT_FOUND" };

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "INVALID_REASON" };

  let components: ComponentInput[];
  try {
    const raw = JSON.parse(String(formData.get("componentsJson") ?? "[]"));
    if (!Array.isArray(raw)) throw new Error("not an array");
    components = raw.map((c: { materialId: string; designMassKgPerM3: number; note?: string | null }) => ({
      materialId: String(c.materialId),
      designMassKgPerM3: Number(c.designMassKgPerM3),
      note: c.note ? String(c.note) : null,
    }));
  } catch {
    return { status: "NO_COMPONENTS" };
  }

  const result = await saveRevisionDomain(reservationId, { reason, actorId: user!.id, components });
  if (result.status === "OK") {
    revalidatePath(`/production/reservationMix/${reservationId}`);
    revalidatePath("/production");
    return { status: "OK" };
  }
  if (result.status === "DUPLICATE_MATERIAL" || result.status === "INVALID_QUANTITY" || result.status === "MATERIAL_NOT_FOUND" || result.status === "UNSUPPORTED_MATERIAL_TYPE" || result.status === "MISSING_SPECIFIC_GRAVITY") {
    return { status: result.status, detail: result.materialId };
  }
  return { status: result.status };
}

export type CancelReservationMixActionState = { status: "OK" | "NOT_FOUND" | "INVALID_STATE" | "NO_ACTIVE_REVISION" } | null;

export async function cancelReservationMixRevisionAction(_prevState: CancelReservationMixActionState, formData: FormData): Promise<CancelReservationMixActionState> {
  const reservationId = String(formData.get("reservationId") ?? "");
  if (!reservationId) return { status: "NOT_FOUND" };

  const { user, reservation } = await requireReservationMixEditScope(reservationId);
  if (!reservation) return { status: "NOT_FOUND" };

  const result = await cancelRevisionDomain(reservationId, { actorId: user!.id });
  if (result.status === "OK") {
    revalidatePath(`/production/reservationMix/${reservationId}`);
    revalidatePath("/production");
  }
  return result;
}
