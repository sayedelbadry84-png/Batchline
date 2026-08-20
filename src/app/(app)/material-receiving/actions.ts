"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createReceipt(formData: FormData) {
  const plantId = String(formData.get("plantId") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const poNumber = String(formData.get("poNumber") ?? "").trim() || null;
  const orderedMassKg = Number(formData.get("orderedMassKg") ?? 0) || null;
  const grossWeightKg = Number(formData.get("grossWeightKg") ?? 0);
  const tareWeightKg = Number(formData.get("tareWeightKg") ?? 0);
  const moisturePct = Number(formData.get("moisturePct") ?? 0) || null;
  const destinationSiloId = String(formData.get("destinationSiloId") ?? "") || null;
  const destinationHopperId = String(formData.get("destinationHopperId") ?? "") || null;

  if (!plantId || !supplierId || !materialId || !grossWeightKg || !tareWeightKg) return;
  if (grossWeightKg <= tareWeightKg) return;

  const netWeightKg = grossWeightKg - tareWeightKg;

  const receipt = await prisma.materialReceipt.create({
    data: {
      plantId,
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
    },
  });

  await logAudit({
    module: "MaterialReceiving",
    recordId: receipt.id,
    afterValue: `${netWeightKg.toFixed(0)} kg net, PO ${poNumber ?? "—"}`,
    reasonCode: "RECEIPT_CAPTURED",
  });

  revalidatePath("/material-receiving");
}

export async function setQcStatus(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !status) return;

  const receipt = await prisma.materialReceipt.findUnique({ where: { id } });
  if (!receipt) return;

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
    role: "QUALITY_SUPERVISOR",
  });

  revalidatePath("/material-receiving");
  revalidatePath("/silos");
  revalidatePath("/");
}
