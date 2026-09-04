"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isPlantActive, isPlantInScope } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

// A destination silo/hopper wasn't checked against what's actually being
// received at all — a form submitted with a mismatched or wrong-site
// destination (typo, stale option in a picker, or a crafted request) would
// silently credit tonnage nothing about the physical delivery supports:
// wrong material into a silo, or wrong site's silo entirely. Mirrors the
// same plantId-own/sharedAcrossPlants-same-site matching production's own
// findMatchingSilo/findMatchingHopper use, and the same equals/startsWith
// aggregate-type distinction (COARSE_AGGREGATE covers any COARSE_* hopper;
// everything else must match exactly).
async function isValidDestination(
  db: Prisma.TransactionClient | typeof prisma,
  plantId: string,
  materialType: string,
  destinationSiloId: string | null,
  destinationHopperId: string | null,
): Promise<boolean> {
  if (!destinationSiloId && !destinationHopperId) return true;
  if (destinationSiloId && destinationHopperId) return false;

  const plant = await db.plant.findUnique({ where: { id: plantId }, select: { siteId: true } });
  if (!plant) return false;

  if (destinationSiloId) {
    const silo = await db.silo.findUnique({ where: { id: destinationSiloId }, include: { plant: true } });
    if (!silo || silo.materialType !== materialType) return false;
    return silo.plantId === plantId || (silo.sharedAcrossPlants && silo.plant.siteId === plant.siteId);
  }

  const hopper = await db.hopper.findUnique({ where: { id: destinationHopperId! }, include: { plant: true } });
  if (!hopper) return false;
  const typeMatches =
    materialType === "SAND" ? hopper.aggregateType === "SAND" : materialType === "COARSE_AGGREGATE" ? hopper.aggregateType.startsWith("COARSE") : hopper.aggregateType === materialType;
  if (!typeMatches) return false;
  return hopper.plantId === plantId || (hopper.sharedAcrossPlants && hopper.plant.siteId === plant.siteId);
}

export async function createReceipt(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "createReceipt");

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

  const material = await prisma.material.findUnique({ where: { id: materialId } });
  if (!material) return;
  if (!(await isValidDestination(prisma, plantId, material.type, destinationSiloId, destinationHopperId))) return;

  const netWeightKg = grossWeightKg - tareWeightKg;

  // The receipt and its PO-line receivedMassKg bump commit as one unit —
  // without this, a failure between the two could leave a real receipt on
  // file with the PO it was ordered against never actually counted as
  // received.
  const receipt = await prisma.$transaction(async (tx) => {
    const receipt = await tx.materialReceipt.create({
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

    if (purchaseOrderLineId) await postReceiptToPurchaseOrderLine(tx, purchaseOrderLineId, netWeightKg);
    return receipt;
  });

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
async function postReceiptToPurchaseOrderLine(db: Prisma.TransactionClient | typeof prisma, purchaseOrderLineId: string, netWeightKg: number) {
  const line = await db.purchaseOrderLine.update({
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
    await db.purchaseOrder.update({ where: { id: line.purchaseOrder.id }, data: { status: newStatus } });
  }
}

// Mirrors postReceiptToPurchaseOrderLine but subtracts — a receipt that
// was already counted toward a PO line's receivedMassKg used to leave that
// figure (and the PO's own RECEIVED/PARTIALLY_RECEIVED status) untouched
// when the receipt was later corrected, deleted, or returned, so the PO
// could keep showing as received against a delivery that no longer exists
// or whose weight changed. Clamped at 0 rather than using a raw decrement
// so a correction can never push received mass negative.
async function reversePOLineReceipt(db: Prisma.TransactionClient | typeof prisma, purchaseOrderLineId: string, netWeightKg: number) {
  const current = await db.purchaseOrderLine.findUnique({
    where: { id: purchaseOrderLineId },
    include: { purchaseOrder: { include: { lines: true } } },
  });
  if (!current) return;

  const newReceivedMassKg = Math.max(0, (current.receivedMassKg ?? 0) - netWeightKg);
  await db.purchaseOrderLine.update({ where: { id: purchaseOrderLineId }, data: { receivedMassKg: newReceivedMassKg } });

  const allReceived = current.purchaseOrder.lines.every((l) => {
    if (l.orderedMassKg == null) return true;
    const received = l.id === purchaseOrderLineId ? newReceivedMassKg : l.receivedMassKg;
    return (received ?? 0) >= l.orderedMassKg;
  });
  const newStatus = allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
  if (current.purchaseOrder.status !== newStatus) {
    await db.purchaseOrder.update({ where: { id: current.purchaseOrder.id }, data: { status: newStatus } });
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
  await requireActionPermission(user, "warehouses", "updateReceipt");

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

  const material = await prisma.material.findUnique({ where: { id: materialId } });
  if (!material) return;
  if (!(await isValidDestination(prisma, receipt.plantId, material.type, destinationSiloId, destinationHopperId))) return;

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

    // The PO line's receivedMassKg was bumped by the OLD net weight at
    // creation, independent of whether the receipt was ever posted to
    // inventory — reverse that and re-apply the corrected weight, or the
    // PO's received total silently drifts away from what this receipt
    // actually says every time it's corrected.
    if (receipt.purchaseOrderLineId) {
      await reversePOLineReceipt(tx, receipt.purchaseOrderLineId, receipt.netWeightKg);
      await postReceiptToPurchaseOrderLine(tx, receipt.purchaseOrderLineId, netWeightKg);
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
  await requireActionPermission(user, "warehouses", "deleteReceipt");

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
    // Same PO-line reversal as updateReceipt above — a deleted receipt
    // must stop counting toward what the PO shows as received.
    if (receipt.purchaseOrderLineId) await reversePOLineReceipt(tx, receipt.purchaseOrderLineId, receipt.netWeightKg);
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
  await requireActionPermission(user, "warehouses", "returnReceiptToSupplier");

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
    // Same PO-line reversal as updateReceipt/deleteReceipt above — a
    // shipment sent back must stop counting toward what the PO shows as
    // received, same as if it had never arrived.
    if (receipt.purchaseOrderLineId) await reversePOLineReceipt(tx, receipt.purchaseOrderLineId, receipt.netWeightKg);
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

// The real incoming-inspection procedure (P/QM/008/2-1) requires a
// written inspection finding before a delivery is accepted or rejected —
// not just the receiving-desk weighing setQcStatus already had. No note,
// no status change, same "no note, no approval" discipline the Quality
// module already uses for CAPA/waste memos/audit findings.
export async function setQcStatus(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "setQcStatus");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const inspectionNotes = String(formData.get("inspectionNotes") ?? "").trim();
  if (!id || !status || !inspectionNotes) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt) return;
  if (!(await isPlantInScope(receipt.plantId, effectiveSiteId(user)))) return;

  const shouldPost = await prisma.$transaction(async (tx) => {
    // Claim "not yet posted" atomically via the update's own WHERE clause,
    // instead of deciding shouldPost from a read taken before the
    // transaction — two concurrent PASS submissions for the same receipt
    // used to both see postedToInventory:false and both credit the silo/
    // hopper. Postgres's row lock on the matching UPDATE serializes this:
    // only the first writer can still match postedToInventory: false —
    // the second's updateMany then matches zero rows.
    const claim =
      status === "PASSED"
        ? await tx.materialReceipt.updateMany({
            where: { id, postedToInventory: false },
            data: { qcStatus: status, postedToInventory: true, inspectedById: user!.id, inspectionDate: new Date(), inspectionNotes },
          })
        : { count: 0 };
    const shouldPost = claim.count > 0;

    if (!shouldPost) {
      await tx.materialReceipt.update({
        where: { id },
        data: { qcStatus: status, inspectedById: user!.id, inspectionDate: new Date(), inspectionNotes },
      });
    }

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

    return shouldPost;
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
