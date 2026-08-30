"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { computeLaborCost } from "@/lib/maintenance";
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

// ---------------------------------------------------------------------------
// Maintenance Orders — a ticket ("the request") converts into one of these
// when the fault needs real work logged: parts issued, technicians on the
// job. Closing a request WITHOUT an order needs no new code here — the
// existing completeMaintenanceTicket/cancelMaintenanceTicket above already
// do exactly that.
// ---------------------------------------------------------------------------

// Refused once the ticket already has an order (ticketId is unique) or is
// already terminal — a ticket converts at most once.
export async function convertTicketToOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const ticketId = String(formData.get("ticketId") ?? "");
  if (!ticketId) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id: ticketId }, include: { order: true } });
  if (!ticket || ticket.order || !["OPEN", "IN_PROGRESS"].includes(ticket.status)) return;

  const order = await withSequentialNumber(
    "MO",
    () => prisma.maintenanceOrder.count(),
    (orderNumber) =>
      prisma.maintenanceOrder.create({
        data: { orderNumber, ticketId, createdById: actor!.id },
      }),
  );

  if (ticket.status === "OPEN") {
    await prisma.maintenanceTicket.update({ where: { id: ticketId }, data: { status: "IN_PROGRESS" } });
  }

  await logAudit({ module: "Maintenance", recordId: order.id, afterValue: `${order.orderNumber} — from ${ticket.ticketNumber}`, reasonCode: "MAINTENANCE_ORDER_CREATED" });
  revalidatePath("/maintenance");
}

export async function startMaintenanceOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id } });
  if (!order || order.status !== "OPEN") return;

  await prisma.maintenanceOrder.update({ where: { id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "IN_PROGRESS", reasonCode: "MAINTENANCE_ORDER_STARTED" });
  revalidatePath("/maintenance");
}

// Same written-resolution-notes requirement as completeMaintenanceTicket.
// Cascades to complete the parent ticket too (same equipment
// lastMaintenanceAt stamp + plan cycle advance), and rolls this order's
// actual parts consumption AND technician hours up into real costs —
// laborCost from computeLaborCost (hoursWorked × each technician's own
// payroll wage, see src/lib/maintenance.ts) the same way partsCost was
// already computed from MaterialOrderPart, instead of either being a
// hand-typed guess.
export async function completeMaintenanceOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim();
  if (!id || !resolutionNotes) return;

  const order = await prisma.maintenanceOrder.findUnique({
    where: { id },
    include: { ticket: { include: { plan: true } }, parts: true, technicians: { include: { employee: true } } },
  });
  if (!order || !["OPEN", "IN_PROGRESS"].includes(order.status)) return;

  const now = new Date();
  const partsCost = order.parts.reduce((sum, p) => sum + p.lineTotal, 0) || null;
  const laborCost = computeLaborCost(order.technicians) || null;

  await prisma.maintenanceOrder.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost },
  });

  const ticket = order.ticket;
  await prisma.maintenanceTicket.update({
    where: { id: ticket.id },
    data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost, partsCost },
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
    reasonCode: "MAINTENANCE_ORDER_COMPLETED",
  });
  revalidatePath("/maintenance");
}

export async function cancelMaintenanceOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id } });
  if (!order || ["COMPLETED", "CANCELLED"].includes(order.status)) return;

  await prisma.maintenanceOrder.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "CANCELLED", reasonCode: "MAINTENANCE_ORDER_CANCELLED" });
  revalidatePath("/maintenance");
}

// Upsert on the (orderId, employeeId) unique pair — re-adding the same
// technician just updates their hours instead of erroring.
export async function addOrderTechnician(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const orderId = String(formData.get("orderId") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  const hoursWorked = Number(formData.get("hoursWorked") ?? 0) || null;
  if (!orderId || !employeeId) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status === "CANCELLED") return;

  await prisma.maintenanceOrderTechnician.upsert({
    where: { orderId_employeeId: { orderId, employeeId } },
    create: { orderId, employeeId, hoursWorked },
    update: { hoursWorked },
  });

  await logAudit({ module: "Maintenance", recordId: orderId, afterValue: `technician ${employeeId}`, reasonCode: "MAINTENANCE_ORDER_TECHNICIAN_ADDED" });
  revalidatePath("/maintenance");
}

export async function removeOrderTechnician(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.maintenanceOrderTechnician.delete({ where: { id } }).catch(() => {});

  revalidatePath("/maintenance");
}

// The core stock-aware issuance: issues whatever's available at the order's
// site right now (deducting from the derived Spare Parts balance — same
// receipts-minus-issuances shape as the existing Stock Ledger report, no
// stored running total), and for any shortfall automatically opens a
// SparePartsRequisition instead of silently under-issuing — the "auto-
// generate a purchase request for what's missing" requirement.
export async function issueSparePartToOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, MAINTENANCE_ROLES);

  const orderId = String(formData.get("orderId") ?? "");
  const sparePartId = String(formData.get("sparePartId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);
  const serialNumber = String(formData.get("serialNumber") ?? "").trim() || null;
  if (!orderId || !sparePartId || !quantity || quantity <= 0) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order || !["OPEN", "IN_PROGRESS"].includes(order.status)) return;

  const sparePart = await prisma.sparePart.findUnique({ where: { id: sparePartId } });
  if (!sparePart) return;
  const unitCost = Number(formData.get("unitCost") ?? 0) || sparePart.lastUnitCost || 0;

  const siteId = order.ticket.siteId;
  const [receivedAgg, issuedAgg] = await Promise.all([
    prisma.sparePartReceipt.aggregate({ where: { sparePartId, siteId }, _sum: { quantity: true } }),
    prisma.maintenanceOrderPart.aggregate({ where: { sparePartId, order: { ticket: { siteId } } }, _sum: { quantity: true } }),
  ]);
  const available = (receivedAgg._sum.quantity ?? 0) - (issuedAgg._sum.quantity ?? 0);
  const issueQty = Math.max(0, Math.min(available, quantity));
  const shortfall = quantity - issueQty;

  if (issueQty > 0) {
    await prisma.maintenanceOrderPart.create({
      data: {
        orderId,
        sparePartId,
        quantity: issueQty,
        unitCost,
        lineTotal: issueQty * unitCost,
        serialNumber,
        issuedById: actor!.id,
      },
    });
    await logAudit({ module: "Maintenance", recordId: orderId, afterValue: `${sparePart.name} × ${issueQty}`, reasonCode: "SPARE_PART_ISSUED" });
  }

  if (shortfall > 0) {
    const requisition = await withSequentialNumber(
      "SPR",
      () => prisma.sparePartsRequisition.count(),
      (requisitionNumber) =>
        prisma.sparePartsRequisition.create({
          data: {
            requisitionNumber,
            sparePartId,
            siteId,
            quantityNeeded: shortfall,
            maintenanceOrderId: orderId,
            requestedById: actor!.id,
          },
        }),
    );
    await logAudit({
      module: "Maintenance",
      recordId: requisition.id,
      afterValue: `${requisition.requisitionNumber} — ${sparePart.name} × ${shortfall}`,
      reasonCode: "SPARE_PARTS_REQUISITION_CREATED",
    });
  }

  revalidatePath("/maintenance");
  revalidatePath("/warehouses");
}
