"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

const MAINTENANCE_ROLES = ["PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"];

export async function createMaintenanceTicket(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const equipmentType = String(formData.get("equipmentType") ?? "");
  const equipmentId = String(formData.get("equipmentId") ?? "");
  const equipmentLabel = String(formData.get("equipmentLabel") ?? "").trim();
  const siteId = String(formData.get("siteId") ?? "");
  const type = String(formData.get("type") ?? "");
  const priority = String(formData.get("priority") ?? "NORMAL");
  const faultDescription = String(formData.get("faultDescription") ?? "").trim() || null;
  const assignedToId = String(formData.get("assignedToId") ?? "") || null;
  const scheduledForRaw = String(formData.get("scheduledFor") ?? "");

  if (!equipmentType || !equipmentId || !equipmentLabel || !siteId || !type) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;
  // A fault report needs a description; a scheduled preventive/inspection
  // job doesn't have one yet (that's what resolutionNotes is for, once
  // work actually happens) — same "the reason must be written" precedent
  // as WasteIncidentMemo.approvalNote elsewhere in this app, applied at
  // the point where it's actually knowable.
  if (type === "CORRECTIVE" && !faultDescription) return;

  const ticket = await withSequentialNumber(
    "MT",
    () => prisma.maintenanceTicket.count(),
    (ticketNumber) =>
      prisma.maintenanceTicket.create({
        data: {
          ticketNumber,
          equipmentType,
          equipmentId,
          equipmentLabel,
          siteId,
          type,
          priority,
          faultDescription,
          reportedById: actor!.id,
          assignedToId,
          scheduledFor: scheduledForRaw ? new Date(scheduledForRaw) : null,
        },
      }),
  );

  await logAudit({ module: "Maintenance", recordId: ticket.id, afterValue: `${ticket.ticketNumber} — ${equipmentLabel}`, reasonCode: "MAINTENANCE_TICKET_CREATED" });
  revalidatePath("/maintenance");
}

export async function startMaintenanceTicket(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id } });
  if (!ticket || ticket.status !== "OPEN") return;

  await prisma.maintenanceTicket.update({ where: { id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "IN_PROGRESS", reasonCode: "MAINTENANCE_TICKET_STARTED" });
  revalidatePath("/maintenance");
}

// Requires written resolution notes — no closing a repair ticket with
// nothing on file about what was actually done, same reasoning as the
// WasteIncidentMemo approval-note requirement. Also the point where the
// underlying equipment's own lastMaintenanceAt gets stamped (for
// TRUCK/PUMP — the two types the existing trip-count dashboard flag in
// src/lib/maintenance.ts already watches) and, if this ticket came off a
// MaintenancePlan, that plan's own cycle advances.
export async function completeMaintenanceTicket(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim();
  const laborCost = Number(formData.get("laborCost") ?? 0) || null;
  const partsCost = Number(formData.get("partsCost") ?? 0) || null;
  const downtimeHours = Number(formData.get("downtimeHours") ?? 0) || null;
  if (!id || !resolutionNotes) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id }, include: { plan: true } });
  if (!ticket || !["OPEN", "IN_PROGRESS"].includes(ticket.status)) return;

  const now = new Date();

  await prisma.maintenanceTicket.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost, partsCost, downtimeHours },
  });

  if (ticket.equipmentType === "TRUCK") {
    await prisma.truck.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
  } else if (ticket.equipmentType === "PUMP") {
    await prisma.pump.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
  }

  if (ticket.plan) {
    const nextDueAt = ticket.plan.intervalDays ? new Date(now.getTime() + ticket.plan.intervalDays * 24 * 60 * 60 * 1000) : null;
    await prisma.maintenancePlan.update({ where: { id: ticket.plan.id }, data: { lastCompletedAt: now, nextDueAt } });
  }

  await logAudit({
    module: "Maintenance",
    recordId: id,
    afterValue: `COMPLETED — labor ${laborCost ?? 0} + parts ${partsCost ?? 0}`,
    reasonCode: "MAINTENANCE_TICKET_COMPLETED",
  });
  revalidatePath("/maintenance");
}

export async function cancelMaintenanceTicket(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id } });
  if (!ticket || ["COMPLETED", "CANCELLED"].includes(ticket.status)) return;

  await prisma.maintenanceTicket.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "CANCELLED", reasonCode: "MAINTENANCE_TICKET_CANCELLED" });
  revalidatePath("/maintenance");
}

export async function createMaintenancePlan(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const equipmentType = String(formData.get("equipmentType") ?? "");
  const equipmentId = String(formData.get("equipmentId") ?? "");
  const equipmentLabel = String(formData.get("equipmentLabel") ?? "").trim();
  const siteId = String(formData.get("siteId") ?? "");
  const intervalDays = Number(formData.get("intervalDays") ?? 0) || null;
  const intervalTrips = Number(formData.get("intervalTrips") ?? 0) || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!equipmentType || !equipmentId || !equipmentLabel || !siteId || (!intervalDays && !intervalTrips)) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const nextDueAt = intervalDays ? new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000) : null;

  const plan = await prisma.maintenancePlan.create({
    data: { equipmentType, equipmentId, equipmentLabel, siteId, intervalDays, intervalTrips, notes, nextDueAt },
  });

  await logAudit({ module: "Maintenance", recordId: plan.id, afterValue: equipmentLabel, reasonCode: "MAINTENANCE_PLAN_CREATED" });
  revalidatePath("/maintenance");
}

export async function deactivateMaintenancePlan(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.maintenancePlan.update({ where: { id }, data: { active: false } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "DEACTIVATED", reasonCode: "MAINTENANCE_PLAN_DEACTIVATED" });
  revalidatePath("/maintenance");
}

// One click from a due plan straight to an open PREVENTIVE ticket — the
// plan's own equipment/site copy across, scheduledFor defaults to the
// plan's nextDueAt (today if somehow already overdue with none set).
export async function generateTicketFromPlan(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const planId = String(formData.get("planId") ?? "");
  if (!planId) return;

  const plan = await prisma.maintenancePlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return;

  const ticket = await withSequentialNumber(
    "MT",
    () => prisma.maintenanceTicket.count(),
    (ticketNumber) =>
      prisma.maintenanceTicket.create({
        data: {
          ticketNumber,
          planId: plan.id,
          equipmentType: plan.equipmentType,
          equipmentId: plan.equipmentId,
          equipmentLabel: plan.equipmentLabel,
          siteId: plan.siteId,
          type: "PREVENTIVE",
          reportedById: actor!.id,
          scheduledFor: plan.nextDueAt ?? new Date(),
        },
      }),
  );

  await logAudit({ module: "Maintenance", recordId: ticket.id, afterValue: `from plan ${plan.id}`, reasonCode: "MAINTENANCE_TICKET_CREATED_FROM_PLAN" });
  revalidatePath("/maintenance");
}
