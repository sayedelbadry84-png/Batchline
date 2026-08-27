import { prisma } from "@/lib/prisma";
import { plantScopeWhere } from "@/lib/siteScope";

// Every piece of equipment a MaintenanceTicket/MaintenancePlan can be
// against, flattened into one list — mirrors how the old dashboard alert
// (src/lib/maintenance.ts) already treats trucks and pumps as "the same
// kind of thing" for a due-for-inspection flag, just extended to every
// unit type the Equipment module manages. No new table: this always reads
// live from Truck/Pump/Silo/Hopper/SupportVehicle directly, so a renamed
// or newly-registered unit shows up here with no separate sync step.
export type EquipmentOption = { type: string; id: string; label: string; siteId: string };

export async function getEquipmentOptions(siteId: string | null): Promise<EquipmentOption[]> {
  const [trucks, pumps, silos, hoppers, supportVehicles] = await Promise.all([
    prisma.truck.findMany({ where: plantScopeWhere(siteId), select: { id: true, code: true, plant: { select: { siteId: true } } } }),
    prisma.pump.findMany({ where: plantScopeWhere(siteId), select: { id: true, code: true, plant: { select: { siteId: true } } } }),
    prisma.silo.findMany({ where: plantScopeWhere(siteId), select: { id: true, name: true, plant: { select: { siteId: true } } } }),
    prisma.hopper.findMany({ where: plantScopeWhere(siteId), select: { id: true, name: true, plant: { select: { siteId: true } } } }),
    prisma.supportVehicle.findMany({ where: plantScopeWhere(siteId), select: { id: true, code: true, type: true, plant: { select: { siteId: true } } } }),
  ]);

  return [
    ...trucks.map((t) => ({ type: "TRUCK", id: t.id, label: t.code, siteId: t.plant.siteId })),
    ...pumps.map((p) => ({ type: "PUMP", id: p.id, label: p.code, siteId: p.plant.siteId })),
    ...silos.map((s) => ({ type: "SILO", id: s.id, label: s.name, siteId: s.plant.siteId })),
    ...hoppers.map((h) => ({ type: "HOPPER", id: h.id, label: h.name, siteId: h.plant.siteId })),
    ...supportVehicles.map((v) => ({ type: v.type, id: v.id, label: v.code, siteId: v.plant.siteId })),
  ];
}

// The equipment-type label dict key each type value maps to — used
// wherever a ticket/plan's equipmentType needs a human label without a
// join back to the source table (the table row may since be gone).
export const EQUIPMENT_TYPES = ["TRUCK", "PUMP", "SILO", "HOPPER", "BULKER", "WATER_TANKER", "LOADER"] as const;
