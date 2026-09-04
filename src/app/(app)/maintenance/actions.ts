"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { computeLaborCost } from "@/lib/maintenance";
import { revalidatePath } from "next/cache";

// Prisma's default 5s interactive-transaction timeout can be exceeded by a
// transaction's several sequential Neon round-trips — matches the same
// TX_OPTIONS already used in billing/finance/employees/production actions.
const TX_OPTIONS = { timeout: 15000 };

export async function createMaintenanceTicket(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "maintenance", "createTicket");

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
    (yr) => prisma.maintenanceTicket.count({ where: { createdAt: yr } }),
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
  await requireActionPermission(actor, "maintenance", "startTicket");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id } });
  if (!ticket || ticket.status !== "OPEN") return;
  if (!isSiteInScope(ticket.siteId, effectiveSiteId(actor))) return;

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
  await requireActionPermission(actor, "maintenance", "completeTicket");

  const id = String(formData.get("id") ?? "");
  const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim();
  // Read the raw string first — `Number(x ?? 0) || null` silently turns a
  // legitimately-entered 0 (no labor charge, no downtime) into null.
  const laborCostRaw = String(formData.get("laborCost") ?? "").trim();
  const partsCostRaw = String(formData.get("partsCost") ?? "").trim();
  const downtimeHoursRaw = String(formData.get("downtimeHours") ?? "").trim();
  const laborCost = laborCostRaw === "" ? null : Number(laborCostRaw);
  const partsCost = partsCostRaw === "" ? null : Number(partsCostRaw);
  const downtimeHours = downtimeHoursRaw === "" ? null : Number(downtimeHoursRaw);
  if (!id || !resolutionNotes) return;
  if ((laborCost !== null && !Number.isFinite(laborCost)) || (partsCost !== null && !Number.isFinite(partsCost)) || (downtimeHours !== null && !Number.isFinite(downtimeHours))) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id }, include: { plan: true } });
  if (!ticket || !["OPEN", "IN_PROGRESS"].includes(ticket.status)) return;
  if (!isSiteInScope(ticket.siteId, effectiveSiteId(actor))) return;

  const now = new Date();

  // The ticket close, the equipment's lastMaintenanceAt stamp, and the
  // plan's cycle advance used to be three independent writes — a crash or
  // error between them could leave the ticket COMPLETED with the equipment
  // still showing its old maintenance date, or a plan cycle that never
  // advances even though the work is done.
  await prisma.$transaction(async (tx) => {
    await tx.maintenanceTicket.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost, partsCost, downtimeHours },
    });

    if (ticket.equipmentType === "TRUCK") {
      await tx.truck.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
    } else if (ticket.equipmentType === "PUMP") {
      await tx.pump.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
    }

    if (ticket.plan) {
      const nextDueAt = ticket.plan.intervalDays ? new Date(now.getTime() + ticket.plan.intervalDays * 24 * 60 * 60 * 1000) : null;
      await tx.maintenancePlan.update({ where: { id: ticket.plan.id }, data: { lastCompletedAt: now, nextDueAt } });
    }
  }, TX_OPTIONS);

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
  await requireActionPermission(actor, "maintenance", "cancelTicket");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id } });
  if (!ticket || ["COMPLETED", "CANCELLED"].includes(ticket.status)) return;
  if (!isSiteInScope(ticket.siteId, effectiveSiteId(actor))) return;

  await prisma.maintenanceTicket.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "CANCELLED", reasonCode: "MAINTENANCE_TICKET_CANCELLED" });
  revalidatePath("/maintenance");
}

export async function createMaintenancePlan(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "maintenance", "createPlan");

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
  await requireActionPermission(actor, "maintenance", "deactivatePlan");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const plan = await prisma.maintenancePlan.findUnique({ where: { id } });
  if (!plan) return;
  if (!isSiteInScope(plan.siteId, effectiveSiteId(actor))) return;

  await prisma.maintenancePlan.update({ where: { id }, data: { active: false } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "DEACTIVATED", reasonCode: "MAINTENANCE_PLAN_DEACTIVATED" });
  revalidatePath("/maintenance");
}

// One click from a due plan straight to an open PREVENTIVE ticket — the
// plan's own equipment/site copy across, scheduledFor defaults to the
// plan's nextDueAt (today if somehow already overdue with none set).
export async function generateTicketFromPlan(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "maintenance", "generateTicketFromPlan");

  const planId = String(formData.get("planId") ?? "");
  if (!planId) return;

  const plan = await prisma.maintenancePlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return;
  if (!isSiteInScope(plan.siteId, effectiveSiteId(actor))) return;

  const ticket = await withSequentialNumber(
    "MT",
    (yr) => prisma.maintenanceTicket.count({ where: { createdAt: yr } }),
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
  await requireActionPermission(actor, "maintenance", "convertToOrder");

  const ticketId = String(formData.get("ticketId") ?? "");
  if (!ticketId) return;

  const ticket = await prisma.maintenanceTicket.findUnique({ where: { id: ticketId }, include: { order: true } });
  if (!ticket || ticket.order || !["OPEN", "IN_PROGRESS"].includes(ticket.status)) return;
  if (!isSiteInScope(ticket.siteId, effectiveSiteId(actor))) return;

  const order = await withSequentialNumber(
    "MO",
    (yr) => prisma.maintenanceOrder.count({ where: { createdAt: yr } }),
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
  await requireActionPermission(actor, "maintenance", "startOrder");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id }, include: { ticket: true } });
  if (!order || order.status !== "OPEN") return;
  if (!isSiteInScope(order.ticket.siteId, effectiveSiteId(actor))) return;

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
  await requireActionPermission(actor, "maintenance", "completeOrder");

  const id = String(formData.get("id") ?? "");
  const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim();
  if (!id || !resolutionNotes) return;

  const order = await prisma.maintenanceOrder.findUnique({
    where: { id },
    include: { ticket: { include: { plan: true } }, parts: true, technicians: { include: { employee: true } } },
  });
  if (!order || !["OPEN", "IN_PROGRESS"].includes(order.status)) return;
  if (!isSiteInScope(order.ticket.siteId, effectiveSiteId(actor))) return;

  const now = new Date();
  const partsCost = order.parts.reduce((sum, p) => sum + p.lineTotal, 0) || null;
  const laborCost = computeLaborCost(order.technicians) || null;
  const ticket = order.ticket;

  // Same atomicity issue as completeMaintenanceTicket — order close, ticket
  // close, equipment stamp, and plan cycle advance were four independent
  // writes with no all-or-nothing guarantee between them.
  await prisma.$transaction(async (tx) => {
    await tx.maintenanceOrder.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost },
    });

    await tx.maintenanceTicket.update({
      where: { id: ticket.id },
      data: { status: "COMPLETED", completedAt: now, resolutionNotes, laborCost, partsCost },
    });

    if (ticket.equipmentType === "TRUCK") {
      await tx.truck.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
    } else if (ticket.equipmentType === "PUMP") {
      await tx.pump.update({ where: { id: ticket.equipmentId }, data: { lastMaintenanceAt: now } }).catch(() => {});
    }

    if (ticket.plan) {
      const nextDueAt = ticket.plan.intervalDays ? new Date(now.getTime() + ticket.plan.intervalDays * 24 * 60 * 60 * 1000) : null;
      await tx.maintenancePlan.update({ where: { id: ticket.plan.id }, data: { lastCompletedAt: now, nextDueAt } });
    }
  }, TX_OPTIONS);

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
  await requireActionPermission(actor, "maintenance", "cancelOrder");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id }, include: { ticket: true } });
  if (!order || ["COMPLETED", "CANCELLED"].includes(order.status)) return;
  if (!isSiteInScope(order.ticket.siteId, effectiveSiteId(actor))) return;

  await prisma.maintenanceOrder.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Maintenance", recordId: id, afterValue: "CANCELLED", reasonCode: "MAINTENANCE_ORDER_CANCELLED" });
  revalidatePath("/maintenance");
}

// Upsert on the (orderId, employeeId) unique pair — re-adding the same
// technician just updates their hours instead of erroring.
export async function addOrderTechnician(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "maintenance", "addTechnician");

  const orderId = String(formData.get("orderId") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  // A technician can legitimately be corrected to 0 logged hours (assigned
  // but hasn't started, or an earlier entry was wrong) — `Number(x ?? 0) ||
  // null` would silently turn that explicit 0 into null instead.
  const hoursWorkedRaw = String(formData.get("hoursWorked") ?? "").trim();
  const hoursWorked = hoursWorkedRaw === "" ? null : Number(hoursWorkedRaw);
  if (!orderId || !employeeId) return;
  if (hoursWorked !== null && !Number.isFinite(hoursWorked)) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order || order.status === "CANCELLED") return;
  if (!isSiteInScope(order.ticket.siteId, effectiveSiteId(actor))) return;

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
  await requireActionPermission(actor, "maintenance", "removeTechnician");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const technician = await prisma.maintenanceOrderTechnician.findUnique({
    where: { id },
    include: { order: { include: { ticket: true } } },
  });
  if (!technician) return;
  if (!isSiteInScope(technician.order.ticket.siteId, effectiveSiteId(actor))) return;

  await prisma.maintenanceOrderTechnician.delete({ where: { id } });

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
  await requireActionPermission(actor, "maintenance", "issueSparePart");

  const orderId = String(formData.get("orderId") ?? "");
  const sparePartId = String(formData.get("sparePartId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);
  const serialNumber = String(formData.get("serialNumber") ?? "").trim() || null;
  if (!orderId || !sparePartId || !quantity || quantity <= 0) return;

  const order = await prisma.maintenanceOrder.findUnique({ where: { id: orderId }, include: { ticket: true } });
  if (!order || !["OPEN", "IN_PROGRESS"].includes(order.status)) return;
  if (!isSiteInScope(order.ticket.siteId, effectiveSiteId(actor))) return;

  const sparePart = await prisma.sparePart.findUnique({ where: { id: sparePartId } });
  if (!sparePart) return;
  const unitCost = Number(formData.get("unitCost") ?? 0) || sparePart.lastUnitCost || 0;

  const siteId = order.ticket.siteId;
  // The availability read and the issuance/requisition writes below used to
  // be separate round trips with no lock between them — two concurrent
  // issuances against the same limited stock could both read the same
  // "available" figure and both succeed, together issuing more than was
  // ever on the shelf. Serializable makes Postgres detect that read-write
  // conflict and abort one of the two competing transactions.
  let issueQty = 0;
  let shortfall = 0;
  let requisitionNumber: string | null = null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Availability has to net out BOTH ways stock leaves — an order-linked
      // issuance here and a direct warehouse issuance (see issueSparePart in
      // warehouses/actions.ts) — or the two paths would silently disagree
      // about how much is actually left on the shelf.
      const [receivedAgg, orderIssuedAgg, directIssuedAgg] = await Promise.all([
        tx.sparePartReceipt.aggregate({ where: { sparePartId, siteId }, _sum: { quantity: true } }),
        tx.maintenanceOrderPart.aggregate({ where: { sparePartId, order: { ticket: { siteId } } }, _sum: { quantity: true } }),
        tx.sparePartIssuance.aggregate({ where: { sparePartId, siteId }, _sum: { quantity: true } }),
      ]);
      const available = (receivedAgg._sum.quantity ?? 0) - (orderIssuedAgg._sum.quantity ?? 0) - (directIssuedAgg._sum.quantity ?? 0);
      const qty = Math.max(0, Math.min(available, quantity));
      const short = quantity - qty;

      if (qty > 0) {
        await tx.maintenanceOrderPart.create({
          data: {
            orderId,
            sparePartId,
            quantity: qty,
            unitCost,
            lineTotal: qty * unitCost,
            serialNumber,
            issuedById: actor!.id,
          },
        });
      }

      let requisitionId: string | null = null;
      let reqNumber: string | null = null;
      if (short > 0) {
        const requisition = await withSequentialNumber(
          "SPR",
          (yr) => tx.sparePartsRequisition.count({ where: { createdAt: yr } }),
          (num) =>
            tx.sparePartsRequisition.create({
              data: {
                requisitionNumber: num,
                sparePartId,
                siteId,
                quantityNeeded: short,
                maintenanceOrderId: orderId,
                requestedById: actor!.id,
              },
            }),
        );
        requisitionId = requisition.id;
        reqNumber = requisition.requisitionNumber;
      }

      return { qty, short, requisitionId, reqNumber };
    }, { ...TX_OPTIONS, isolationLevel: "Serializable" });
    issueQty = result.qty;
    shortfall = result.short;
    requisitionNumber = result.reqNumber;

    if (issueQty > 0) {
      await logAudit({ module: "Maintenance", recordId: orderId, afterValue: `${sparePart.name} × ${issueQty}`, reasonCode: "SPARE_PART_ISSUED" });
    }
    if (shortfall > 0 && result.requisitionId) {
      await logAudit({
        module: "Maintenance",
        recordId: result.requisitionId,
        afterValue: `${requisitionNumber} — ${sparePart.name} × ${shortfall}`,
        reasonCode: "SPARE_PARTS_REQUISITION_CREATED",
      });
    }
  } catch {
    return;
  }

  revalidatePath("/maintenance");
  revalidatePath("/warehouses");
}
