"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isPlantActive, isPlantInScope } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

export async function createReceipt(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  // Optional link to a real Purchasing PurchaseOrderLine (see the
  // "purchasingLineId" picker on this form when one or more open PO lines
  // exist for the chosen supplier+material) — poNumber stays free-text
  // either way, just auto-filled from the PO's own number when a line is
  // picked, same as before this existed for an ad-hoc receipt.
  const purchaseOrderLineId = String(formData.get("purchaseOrderLineId") ?? "") || null;
  const poNumber = String(formData.get("poNumber") ?? "").trim() || null;
  const orderedMassKg = Number(formData.get("orderedMassKg") ?? 0) || null;
  const grossWeightKg = Number(formData.get("grossWeightKg") ?? 0);
  const tareWeightKg = Number(formData.get("tareWeightKg") ?? 0);
  const moisturePct = Number(formData.get("moisturePct") ?? 0) || null;
  const destinationSiloId = String(formData.get("destinationSiloId") ?? "") || null;
  const destinationHopperId = String(formData.get("destinationHopperId") ?? "") || null;
  const driverId = String(formData.get("driverId") ?? "") || null;
  const driverName = String(formData.get("driverName") ?? "").trim() || null;

  if (!plantId || !supplierId || !materialId || !grossWeightKg || !tareWeightKg) return;
  if (grossWeightKg <= tareWeightKg) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user!)))) return;
  if (!(await isPlantActive(plantId))) return;

  const netWeightKg = grossWeightKg - tareWeightKg;

  const receipt = await prisma.materialReceipt.create({
    data: {
      plantId,
      supplierId,
      materialId,
      poNumber,
      purchaseOrderLineId,
      orderedMassKg,
      grossWeightKg,
      tareWeightKg,
      netWeightKg,
      moisturePct,
      destinationSiloId,
      destinationHopperId,
      driverId,
      driverName,
    },
  });

  if (purchaseOrderLineId) await postReceiptToPurchaseOrderLine(purchaseOrderLineId, netWeightKg);

  await logAudit({
    module: "MaterialReceiving",
    recordId: receipt.id,
    afterValue: `${netWeightKg.toFixed(0)} kg net, PO ${poNumber ?? "—"}`,
    reasonCode: "RECEIPT_CAPTURED",
  });

  revalidatePath("/warehouses");
  revalidatePath("/purchasing");
}

// Bumps the PO line's running received total and, once every line on the
// order is fully (or over-)received, flips the order itself to RECEIVED —
// otherwise PARTIALLY_RECEIVED, the same "derive the parent's status from
// its children" shape releaseTicketForReservation uses for a Reservation
// once all its batch tickets are in. netWeightKg is added in kilograms;
// PurchaseOrderLine.orderedMassKg/receivedMassKg are also kilograms, so no
// unit conversion is needed here.
async function postReceiptToPurchaseOrderLine(purchaseOrderLineId: string, netWeightKg: number) {
  const line = await prisma.purchaseOrderLine.update({
    where: { id: purchaseOrderLineId },
    data: { receivedMassKg: { increment: netWeightKg } },
    include: { purchaseOrder: { include: { lines: true } } },
  });

  // Spare-part lines (orderedMassKg null) aren't this function's concern —
  // their own received-quantity tracking lives in the Spare Parts warehouse
  // instead, so they're treated as already-satisfied here.
  const allReceived = line.purchaseOrder.lines.every((l) => {
    if (l.orderedMassKg == null) return true;
    const received = l.id === line.id ? line.receivedMassKg : l.receivedMassKg;
    return (received ?? 0) >= l.orderedMassKg;
  });
  const newStatus = allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
  if (line.purchaseOrder.status !== newStatus) {
    await prisma.purchaseOrder.update({ where: { id: line.purchaseOrder.id }, data: { status: newStatus } });
  }
}

// Editable at any point, posted to inventory or not. A not-yet-posted
// receipt is a plain field update. A posted one needs its old contribution
// reversed from wherever it landed before the corrected one is applied —
// same reverse-then-reapply pattern deleteReceipt/returnReceiptToSupplier/
// setQcStatus below already use — so a silo/hopper balance stays exactly
// as accurate as if the correction had been entered right the first time.
// Which plant this happened at is deliberately never editable here — that's
// a physical fact about where the truck actually weighed in, not a typo.
export async function updateReceipt(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const poNumber = String(formData.get("poNumber") ?? "").trim() || null;
  const orderedMassKg = Number(formData.get("orderedMassKg") ?? 0) || null;
  const grossWeightKg = Number(formData.get("grossWeightKg") ?? 0);
  const tareWeightKg = Number(formData.get("tareWeightKg") ?? 0);
  const moisturePct = Number(formData.get("moisturePct") ?? 0) || null;
  const destinationSiloId = String(formData.get("destinationSiloId") ?? "") || null;
  const destinationHopperId = String(formData.get("destinationHopperId") ?? "") || null;
  const driverId = String(formData.get("driverId") ?? "") || null;
  const driverName = String(formData.get("driverName") ?? "").trim() || null;

  if (!id || !supplierId || !materialId || !grossWeightKg || !tareWeightKg) return;
  if (grossWeightKg <= tareWeightKg) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt) return;
  if (!(await isPlantInScope(receipt.plantId, effectiveSiteId(user)))) return;

  const netWeightKg = grossWeightKg - tareWeightKg;

  await prisma.$transaction(async (tx) => {
    if (receipt.postedToInventory) {
      const oldNetTons = receipt.netWeightKg / 1000;
      if (receipt.destinationSiloId) {
        const silo = await tx.silo.findUnique({ where: { id: receipt.destinationSiloId } });
        if (silo) await tx.silo.update({ where: { id: silo.id }, data: { currentLevelTons: Math.max(0, silo.currentLevelTons - oldNetTons) } });
      } else if (receipt.destinationHopperId) {
        const hopper = await tx.hopper.findUnique({ where: { id: receipt.destinationHopperId } });
        if (hopper) await tx.hopper.update({ where: { id: hopper.id }, data: { currentLevelTons: Math.max(0, hopper.currentLevelTons - oldNetTons) } });
      }

      const newNetTons = netWeightKg / 1000;
      if (destinationSiloId) {
        const silo = await tx.silo.findUnique({ where: { id: destinationSiloId } });
        if (silo) await tx.silo.update({ where: { id: silo.id }, data: { currentLevelTons: silo.currentLevelTons + newNetTons } });
      } else if (destinationHopperId) {
        const hopper = await tx.hopper.findUnique({ where: { id: destinationHopperId } });
        if (hopper) await tx.hopper.update({ where: { id: hopper.id }, data: { currentLevelTons: hopper.currentLevelTons + newNetTons } });
      }
    }

    await tx.materialReceipt.update({
      where: { id },
      data: {
        supplierId,
        materialId,
        poNumber,
        orderedMassKg,
        grossWeightKg,
        tareWeightKg,
        netWeightKg,
        moisturePct,
        destinationSiloId,
        destinationHopperId,
        driverId,
        driverName,
      },
    });
  });

  await logAudit({
    module: "MaterialReceiving",
    recordId: id,
    afterValue: `${netWeightKg.toFixed(0)} kg net, PO ${poNumber ?? "—"}`,
    reasonCode: receipt.postedToInventory ? "RECEIPT_UPDATED_INVENTORY_ADJUSTED" : "RECEIPT_UPDATED",
  });

  revalidatePath("/warehouses");
  revalidatePath("/warehouses");
  revalidatePath("/");
}

// Reverses the posted amount (if any) from wherever it landed, then
// removes the row outright — for a receipt that was captured in error and
// never should have existed, as opposed to a real shipment being sent
// back (see returnReceiptToSupplier below, which keeps the record).
export async function deleteReceipt(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt) return;
  if (!(await isPlantInScope(receipt.plantId, effectiveSiteId(user)))) return;

  await prisma.$transaction(async (tx) => {
    if (receipt.postedToInventory) {
      const netTons = receipt.netWeightKg / 1000;
      if (receipt.destinationSiloId) {
        const silo = await tx.silo.findUnique({ where: { id: receipt.destinationSiloId } });
        if (silo) {
          await tx.silo.update({ where: { id: silo.id }, data: { currentLevelTons: Math.max(0, silo.currentLevelTons - netTons) } });
        }
      } else if (receipt.destinationHopperId) {
        const hopper = await tx.hopper.findUnique({ where: { id: receipt.destinationHopperId } });
        if (hopper) {
          await tx.hopper.update({ where: { id: hopper.id }, data: { currentLevelTons: Math.max(0, hopper.currentLevelTons - netTons) } });
        }
      }
    }
    await tx.materialReceipt.delete({ where: { id } });
  });

  await logAudit({
    module: "MaterialReceiving",
    recordId: id,
    reasonCode: receipt.postedToInventory ? "RECEIPT_DELETED_INVENTORY_REVERSED" : "RECEIPT_DELETED",
  });

  revalidatePath("/warehouses");
  revalidatePath("/warehouses");
  revalidatePath("/");
}

// A real shipment being sent back to the supplier — kept on file as a
// RETURNED record (unlike deleteReceipt) since it's a real event that
// happened, not a data-entry mistake. Reverses the posted amount the same
// way deleteReceipt does, if it had already landed in inventory.
export async function returnReceiptToSupplier(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt || receipt.qcStatus === "RETURNED") return;
  if (!(await isPlantInScope(receipt.plantId, effectiveSiteId(user)))) return;

  await prisma.$transaction(async (tx) => {
    if (receipt.postedToInventory) {
      const netTons = receipt.netWeightKg / 1000;
      if (receipt.destinationSiloId) {
        const silo = await tx.silo.findUnique({ where: { id: receipt.destinationSiloId } });
        if (silo) {
          await tx.silo.update({ where: { id: silo.id }, data: { currentLevelTons: Math.max(0, silo.currentLevelTons - netTons) } });
        }
      } else if (receipt.destinationHopperId) {
        const hopper = await tx.hopper.findUnique({ where: { id: receipt.destinationHopperId } });
        if (hopper) {
          await tx.hopper.update({ where: { id: hopper.id }, data: { currentLevelTons: Math.max(0, hopper.currentLevelTons - netTons) } });
        }
      }
    }
    await tx.materialReceipt.update({ where: { id }, data: { qcStatus: "RETURNED", postedToInventory: false } });
  });

  await logAudit({
    module: "MaterialReceiving",
    recordId: id,
    field: "qcStatus",
    beforeValue: receipt.qcStatus,
    afterValue: "RETURNED",
    reasonCode: "RECEIPT_RETURNED_TO_SUPPLIER",
  });

  revalidatePath("/warehouses");
  revalidatePath("/warehouses");
  revalidatePath("/");
}

export async function setQcStatus(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !status) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt) return;
  if (!(await isPlantInScope(receipt.plantId, effectiveSiteId(user)))) return;

  const shouldPost = status === "PASSED" && !receipt.postedToInventory;

  await prisma.$transaction(async (tx) => {
    await tx.materialReceipt.update({
      where: { id },
      data: { qcStatus: status, postedToInventory: shouldPost ? true : receipt.postedToInventory },
    });

    if (shouldPost) {
      const netTons = receipt.netWeightKg / 1000;
      if (receipt.destinationSiloId) {
        const silo = await tx.silo.findUnique({ where: { id: receipt.destinationSiloId } });
        if (silo) {
          await tx.silo.update({
            where: { id: silo.id },
            data: { currentLevelTons: silo.currentLevelTons + netTons },
          });
        }
      } else if (receipt.destinationHopperId) {
        const hopper = await tx.hopper.findUnique({ where: { id: receipt.destinationHopperId } });
        if (hopper) {
          await tx.hopper.update({
            where: { id: hopper.id },
            data: { currentLevelTons: hopper.currentLevelTons + netTons },
          });
        }
      }
    }
  });

  await logAudit({
    module: "MaterialReceiving",
    recordId: id,
    field: "qcStatus",
    beforeValue: receipt.qcStatus,
    afterValue: status,
    reasonCode: shouldPost ? "QC_PASSED_POSTED_TO_INVENTORY" : "QC_STATUS_UPDATED",
  });

  revalidatePath("/warehouses");
  revalidatePath("/warehouses");
  revalidatePath("/");
}
