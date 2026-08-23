import "server-only";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// Called from an update action once the write is already authorized —
// compares the record's previous plantId to the one just submitted and, if
// it changed, logs a dedicated TRANSFERRED event carrying the human-
// readable before/after site+line names, distinct from the record's own
// generic *_UPDATED event, so the audit trail reads as "moved from X to Y"
// (per the "تتبع التوزيع والانتقال" requirement) instead of just "something
// on this record changed."
export async function logTransferIfChanged(module: string, recordId: string, oldPlantId: string, newPlantId: string) {
  if (oldPlantId === newPlantId) return;

  const [oldPlant, newPlant] = await Promise.all([
    prisma.plant.findUnique({ where: { id: oldPlantId }, include: { site: true } }),
    prisma.plant.findUnique({ where: { id: newPlantId }, include: { site: true } }),
  ]);

  await logAudit({
    module,
    recordId,
    field: "plant",
    beforeValue: oldPlant ? `${oldPlant.site.name} / ${oldPlant.name}` : oldPlantId,
    afterValue: newPlant ? `${newPlant.site.name} / ${newPlant.name}` : newPlantId,
    reasonCode: "TRANSFERRED",
  });
}
