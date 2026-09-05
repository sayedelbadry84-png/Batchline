"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import {
  saveReservationMixRevision as saveRevisionDomain,
  cancelActiveReservationMixRevision as cancelRevisionDomain,
  getEffectiveMix,
  type ComponentInput,
} from "@/lib/reservationMixRevisions";
import { revalidatePath } from "next/cache";

// Thin Server Action wrappers around reservationMixRevisions.ts's domain
// functions — the actual claim/create/supersede logic lives there (pure,
// no session/formData access, callable from tests directly), same split
// as every other feature this session (batchCompletion.ts,
// shortageOverrideRequests.ts, ...). These wrappers only handle
// permission/scope checks, parsing formData, and turning the typed
// result into an audit trail and a useActionState-shaped return.

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
  if (!isSiteInScope(reservation.siteId, effectiveSiteId(user))) return { user, reservation: null };
  return { user, reservation };
}

export type SaveReservationMixActionState = {
  status: "OK" | "NOT_FOUND" | "INVALID_STATE" | "NO_COMPONENTS" | "DUPLICATE_MATERIAL" | "INVALID_QUANTITY" | "MATERIAL_NOT_FOUND" | "INVALID_REASON";
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

  const before = await getEffectiveMix(prisma, reservationId, reservation.mixId);

  const result = await saveRevisionDomain(reservationId, { reason, actorId: user!.id, components });
  if (result.status === "OK") {
    await logAudit({
      module: "Production",
      recordId: reservationId,
      field: "mixRevision",
      beforeValue: JSON.stringify(before.components),
      afterValue: JSON.stringify({ revisionNumber: result.revisionNumber, reason, components }),
      reasonCode: "RESERVATION_MIX_REVISED",
    });
    revalidatePath(`/production/reservationMix/${reservationId}`);
    revalidatePath("/production");
    return { status: "OK" };
  }
  if (result.status === "DUPLICATE_MATERIAL" || result.status === "INVALID_QUANTITY" || result.status === "MATERIAL_NOT_FOUND") {
    return { status: result.status, detail: result.materialId };
  }
  return { status: result.status };
}

export type CancelReservationMixActionState = { status: "OK" | "NOT_FOUND" | "NO_ACTIVE_REVISION" } | null;

export async function cancelReservationMixRevisionAction(_prevState: CancelReservationMixActionState, formData: FormData): Promise<CancelReservationMixActionState> {
  const reservationId = String(formData.get("reservationId") ?? "");
  if (!reservationId) return { status: "NOT_FOUND" };

  const { user, reservation } = await requireReservationMixEditScope(reservationId);
  if (!reservation) return { status: "NOT_FOUND" };

  const result = await cancelRevisionDomain(reservationId, { actorId: user!.id });
  if (result.status === "OK") {
    await logAudit({ module: "Production", recordId: reservationId, field: "mixRevision", reasonCode: "RESERVATION_MIX_REVISION_CANCELLED" });
    revalidatePath(`/production/reservationMix/${reservationId}`);
    revalidatePath("/production");
  }
  return result;
}
