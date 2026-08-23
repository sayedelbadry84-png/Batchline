import { prisma } from "@/lib/prisma";
import { type PumpOperatorTrips } from "@/lib/incentives";

// One function per exportable report in the Reports module — each takes a
// plain date range plus an optional scope: siteId rolls up every
// production line at that site combined (a site can run more than one
// line sharing the same yard), plantId narrows to exactly one line's own
// numbers. plantId wins if both are somehow set. Neither set means every
// site combined — the Overview tab's "whole company" default. Kept here
// rather than inline in page.tsx so the same query can be reused by both
// the on-screen table and (eventually) any other consumer without
// re-deriving the aggregation logic.

export type ReportFilter = { from: Date; to: Date; siteId?: string; plantId?: string };

// For models with their own plantId scalar (BatchTicket, MaterialReceipt,
// Silo, ...).
function plantScopeWhere(siteId?: string, plantId?: string) {
  if (plantId) return { plantId };
  if (siteId) return { plant: { siteId } };
  return {};
}

// For Trip, which has no plantId of its own — its "site" is whichever
// plant released the batch ticket it's fulfilling.
function tripPlantScopeWhere(siteId?: string, plantId?: string) {
  if (plantId) return { batchTicket: { plantId } };
  if (siteId) return { batchTicket: { plant: { siteId } } };
  return {};
}

export async function getProductionReport({ from, to, siteId, plantId }: ReportFilter) {
  const tickets = await prisma.batchTicket.findMany({
    where: { releasedAt: { gte: from, lte: to }, ...plantScopeWhere(siteId, plantId) },
    include: { mix: true, reservation: { include: { project: { include: { customer: true } } } }, plant: true },
    orderBy: { releasedAt: "asc" },
  });
  const totalVolumeM3 = tickets.reduce((sum, t) => sum + t.volumeM3, 0);
  const completedCount = tickets.filter((t) => t.status === "COMPLETE").length;
  return { rows: tickets, totalVolumeM3, ticketCount: tickets.length, completedCount };
}

export async function getIncomingReport({ from, to, siteId, plantId }: ReportFilter) {
  const receipts = await prisma.materialReceipt.findMany({
    where: { receivedAt: { gte: from, lte: to }, ...plantScopeWhere(siteId, plantId) },
    include: { supplier: true, material: true, plant: true, driver: true },
    orderBy: { receivedAt: "asc" },
  });
  const totalNetKg = receipts.reduce((sum, r) => sum + r.netWeightKg, 0);
  return { rows: receipts, totalNetKg, receiptCount: receipts.length };
}

export async function getConsumptionReport({ from, to, siteId, plantId }: ReportFilter) {
  const tickets = await prisma.batchTicket.findMany({
    where: { status: "COMPLETE", batchCompletedAt: { gte: from, lte: to }, ...plantScopeWhere(siteId, plantId) },
    include: { components: { include: { material: true } } },
  });

  const byMaterial = new Map<string, { materialName: string; type: string; massKg: number; ticketCount: number }>();
  for (const t of tickets) {
    for (const c of t.components) {
      const massKg = c.actualMassKg ?? c.targetMassKg;
      const entry = byMaterial.get(c.materialId) ?? { materialName: c.material.name, type: c.material.type, massKg: 0, ticketCount: 0 };
      entry.massKg += massKg;
      entry.ticketCount += 1;
      byMaterial.set(c.materialId, entry);
    }
  }
  const rows = Array.from(byMaterial.values()).sort((a, b) => b.massKg - a.massKg);
  return { rows, ticketCount: tickets.length };
}

export async function getReturnsReport({ from, to, siteId, plantId }: ReportFilter) {
  const scope = tripPlantScopeWhere(siteId, plantId);
  const returns = await prisma.drumReturn.findMany({
    where: { trip: { dischargeEnd: { gte: from, lte: to }, ...scope } },
    include: { trip: { include: { truck: true, driver: true, batchTicket: { include: { reservation: { include: { project: true } } } } } } },
    orderBy: { trip: { dischargeEnd: "asc" } },
  });
  const totalReturnedM3 = returns.reduce((sum, r) => sum + r.returnedVolumeM3, 0);
  const wastedM3 = returns.filter((r) => r.disposition === "FULL_WASTE").reduce((sum, r) => sum + r.returnedVolumeM3, 0);
  const reclaimedM3 = returns.filter((r) => r.fate === "RECLAIMED").reduce((sum, r) => sum + r.returnedVolumeM3, 0);

  // "In the drums now" (RhinoMaster's framing) — a return logged as still
  // usable (not FULL_WASTE) but never actually resolved to DUMPED or
  // RECLAIMED. Not date-range-scoped like the rows above: a truck sitting
  // on unresolved concrete from last week is exactly the thing this list
  // exists to surface, range or no range.
  const pendingFate = await prisma.drumReturn.findMany({
    where: { disposition: { not: "FULL_WASTE" }, fate: null, ...(siteId || plantId ? { trip: scope } : {}) },
    include: { trip: { include: { truck: true, driver: true } } },
    orderBy: { trip: { dischargeEnd: "desc" } },
  });

  return { rows: returns, totalReturnedM3, wastedM3, reclaimedM3, returnCount: returns.length, pendingFate };
}

export async function getTripsReport({ from, to, siteId, plantId }: ReportFilter) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, ...tripPlantScopeWhere(siteId, plantId) },
    include: { truck: true, driver: true, pump: true, batchTicket: { include: { reservation: { include: { project: true } } } } },
    orderBy: { dischargeEnd: "asc" },
  });
  const totalDeliveredM3 = trips.reduce((sum, t) => sum + (t.volumeDeliveredM3 ?? 0), 0);
  const cycleTimes = trips.filter((t) => t.dischargeEnd).map((t) => (t.dischargeEnd!.getTime() - t.batchTime.getTime()) / 60000);
  const avgCycleTimeMin = cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null;
  return { rows: trips, totalDeliveredM3, tripCount: trips.length, avgCycleTimeMin };
}

export async function getEquipmentProductivityReport({ from, to, siteId, plantId }: ReportFilter) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, ...tripPlantScopeWhere(siteId, plantId) },
    include: { truck: true, pump: true },
  });

  const byTruck = new Map<string, { code: string; tripCount: number; volumeM3: number }>();
  const byPump = new Map<string, { code: string; tripCount: number; volumeM3: number }>();
  for (const t of trips) {
    const vol = t.volumeDeliveredM3 ?? 0;
    const truckEntry = byTruck.get(t.truckId) ?? { code: t.truck.code, tripCount: 0, volumeM3: 0 };
    truckEntry.tripCount += 1;
    truckEntry.volumeM3 += vol;
    byTruck.set(t.truckId, truckEntry);

    if (t.pumpId && t.pump) {
      const pumpEntry = byPump.get(t.pumpId) ?? { code: t.pump.code, tripCount: 0, volumeM3: 0 };
      pumpEntry.tripCount += 1;
      pumpEntry.volumeM3 += vol;
      byPump.set(t.pumpId, pumpEntry);
    }
  }

  return {
    trucks: Array.from(byTruck.values()).sort((a, b) => b.volumeM3 - a.volumeM3),
    pumps: Array.from(byPump.values()).sort((a, b) => b.volumeM3 - a.volumeM3),
  };
}

// Every role that physically moves material, in one activity report — not
// payout-focused (see the Incentives module for that), just "who did how
// much" across all five roles' own source of trips/deliveries.
export async function getWorkerProductivityReport({ from, to, siteId, plantId }: ReportFilter) {
  const tripScope = tripPlantScopeWhere(siteId, plantId);
  const receiptScope = plantScopeWhere(siteId, plantId);

  const [driverTrips, operatorTrips, assistantTrips, bulkerReceipts, waterReceipts] = await Promise.all([
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, ...tripScope },
      select: { driverId: true, driver: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpOperatorId: { not: null }, ...tripScope },
      select: { pumpOperatorId: true, pumpOperatorCrew: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpAssistantId: { not: null }, ...tripScope },
      select: { pumpAssistantId: true, pumpAssistantCrew: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "CEMENT" }, ...receiptScope },
      select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "WATER" }, ...receiptScope },
      select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true },
    }),
  ]);

  type Row = { key: string; name: string; role: string; count: number; volumeM3: number };
  const rows: Row[] = [];

  function addTripGroup(items: { id: string | null; name: string | undefined }[], volumes: number[], role: string) {
    const byId = new Map<string, Row>();
    items.forEach((item, i) => {
      if (!item.id || !item.name) return;
      const entry = byId.get(item.id) ?? { key: `${role}:${item.id}`, name: item.name, role, count: 0, volumeM3: 0 };
      entry.count += 1;
      entry.volumeM3 += volumes[i] ?? 0;
      byId.set(item.id, entry);
    });
    rows.push(...byId.values());
  }

  addTripGroup(driverTrips.map((t) => ({ id: t.driverId, name: t.driver.name })), driverTrips.map((t) => t.volumeDeliveredM3 ?? 0), "MIXER_DRIVER");
  addTripGroup(operatorTrips.map((t) => ({ id: t.pumpOperatorId, name: t.pumpOperatorCrew?.name })), operatorTrips.map((t) => t.volumeDeliveredM3 ?? 0), "PUMP_OPERATOR");
  addTripGroup(assistantTrips.map((t) => ({ id: t.pumpAssistantId, name: t.pumpAssistantCrew?.name })), assistantTrips.map((t) => t.volumeDeliveredM3 ?? 0), "PUMP_ASSISTANT");

  function addReceiptGroup(items: { driverId: string | null; driverName: string | null; driver: { name: string } | null; netWeightKg: number }[], role: string) {
    const byKey = new Map<string, Row>();
    for (const r of items) {
      const name = r.driver?.name ?? r.driverName;
      if (!name) continue;
      const key = r.driverId ?? `name:${name}`;
      const entry = byKey.get(key) ?? { key: `${role}:${key}`, name, role, count: 0, volumeM3: 0 };
      entry.count += 1;
      entry.volumeM3 += r.netWeightKg / 1000; // tons, displayed alongside m³ rows with its own unit in the UI
      byKey.set(key, entry);
    }
    rows.push(...byKey.values());
  }
  addReceiptGroup(bulkerReceipts, "BULKER_DRIVER");
  addReceiptGroup(waterReceipts, "WATER_TANKER_DRIVER");

  rows.sort((a, b) => b.volumeM3 - a.volumeM3);
  return { rows };
}

// Per-trip/delivery volume (and, for pump crew, reach) for a given
// incentive role in a date range — the raw material
// calculateVolumeIncentivePayout needs when that role's method is
// VOLUME_M3 (see IncentiveMethod/DEFAULT_INCENTIVE_METHOD). Mirrors
// volumeTripsForRole in the Incentives module's own page (which is
// month-scoped, not range-scoped), kept separate rather than shared since
// the two callers' time windows don't line up. Covers all five incentive
// roles, not just PUMP_OPERATOR, since any of them can now use this method.
export async function getVolumeTripDetailsForRole(role: string, { from, to, siteId, plantId }: ReportFilter): Promise<PumpOperatorTrips[]> {
  const byId = new Map<string, PumpOperatorTrips>();
  const push = (id: string | null | undefined, name: string | null | undefined, volumeM3: number, reachM: number | null) => {
    if (!id || !name) return;
    const entry = byId.get(id) ?? { driverId: id, driverName: name, trips: [] };
    entry.trips.push({ volumeM3, reachM });
    byId.set(id, entry);
  };
  const tripScope = tripPlantScopeWhere(siteId, plantId);
  const receiptScope = plantScopeWhere(siteId, plantId);

  if (role === "MIXER_DRIVER") {
    const trips = await prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, ...tripScope },
      select: { driverId: true, driver: { select: { name: true } }, volumeDeliveredM3: true },
    });
    for (const t of trips) push(t.driverId, t.driver.name, t.volumeDeliveredM3 ?? 0, null);
  } else if (role === "PUMP_OPERATOR" || role === "PUMP_ASSISTANT") {
    const crewField = role === "PUMP_OPERATOR" ? "pumpOperatorId" : "pumpAssistantId";
    const trips = await prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, [crewField]: { not: null }, ...tripScope },
      select: {
        pumpOperatorId: true,
        pumpAssistantId: true,
        pumpOperatorCrew: { select: { name: true } },
        pumpAssistantCrew: { select: { name: true } },
        volumeDeliveredM3: true,
        pump: { select: { reachM: true } },
      },
    });
    for (const t of trips) {
      const id = role === "PUMP_OPERATOR" ? t.pumpOperatorId : t.pumpAssistantId;
      const name = role === "PUMP_OPERATOR" ? t.pumpOperatorCrew?.name : t.pumpAssistantCrew?.name;
      push(id, name, t.volumeDeliveredM3 ?? 0, t.pump?.reachM ?? null);
    }
  } else if (role === "BULKER_DRIVER" || role === "WATER_TANKER_DRIVER") {
    const materialType = role === "BULKER_DRIVER" ? "CEMENT" : "WATER";
    const receipts = await prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: materialType }, ...receiptScope },
      select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true },
    });
    for (const r of receipts) {
      const name = r.driver?.name ?? r.driverName;
      push(r.driverId ?? (name ? `name:${name}` : null), name, r.netWeightKg / 1000, null);
    }
  }
  return Array.from(byId.values());
}
