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

// Period-level cost vs. revenue, not a per-ticket costing engine (see the
// Profitability report's "explicitly out of scope" note). Material cost
// uses Material.lastUnitCost — a manually-maintained standard cost, not
// tied to any specific receipt — so this prices historical volume at
// today's standard cost, not what was actually paid at the time.
export async function getProfitabilityReport({ from, to, siteId, plantId }: ReportFilter) {
  const tickets = await prisma.batchTicket.findMany({
    where: { status: "COMPLETE", batchCompletedAt: { gte: from, lte: to }, ...plantScopeWhere(siteId, plantId) },
    include: { components: { include: { material: true } } },
  });
  const totalVolumeM3 = tickets.reduce((sum, t) => sum + t.volumeM3, 0);

  let materialCost = 0;
  let pricedComponents = 0;
  let unpricedComponents = 0;
  for (const t of tickets) {
    for (const c of t.components) {
      const massKg = c.actualMassKg ?? c.targetMassKg;
      if (c.material.lastUnitCost != null) {
        materialCost += massKg * c.material.lastUnitCost;
        pricedComponents += 1;
      } else {
        unpricedComponents += 1;
      }
    }
  }

  // Revenue — real issued invoices in the period, same filter shape as the
  // Overview tab's invoicedThisMonth (reports/page.tsx).
  const invoices = await prisma.invoice.findMany({
    where: {
      issueDate: { gte: from, lte: to },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      ...(plantId ? { plantId } : siteId ? { plant: { siteId } } : {}),
    },
  });
  const revenue = invoices.reduce((sum, inv) => sum + inv.total, 0);

  // CashTransaction has no plantId of its own (it's a site-level ledger) —
  // a plantId filter still resolves up to that plant's own site, since a
  // single production line's own cash movements aren't tracked separately
  // from the rest of its site.
  let cashSiteId = siteId;
  if (plantId && !cashSiteId) {
    const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { siteId: true } });
    cashSiteId = plant?.siteId;
  }
  const cashWhere = (category: string) => ({
    direction: "OUT",
    category,
    occurredAt: { gte: from, lte: to },
    ...(cashSiteId ? { siteId: cashSiteId } : {}),
  });
  const [laborTxns, maintenanceTxns, fuelTxns, utilitiesTxns, operatingTxns, otherTxns] = await Promise.all([
    prisma.cashTransaction.findMany({ where: cashWhere("PAYROLL") }),
    prisma.cashTransaction.findMany({ where: cashWhere("MAINTENANCE") }),
    prisma.cashTransaction.findMany({ where: cashWhere("FUEL") }),
    prisma.cashTransaction.findMany({ where: cashWhere("UTILITIES") }),
    prisma.cashTransaction.findMany({ where: cashWhere("OPERATING_EXPENSE") }),
    prisma.cashTransaction.findMany({ where: cashWhere("OTHER") }),
  ]);
  const sumAmount = (rows: { amount: number }[]) => rows.reduce((sum, r) => sum + r.amount, 0);
  const laborCost = sumAmount(laborTxns);
  const maintenanceCost = sumAmount(maintenanceTxns);
  const fuelCost = sumAmount(fuelTxns);
  const utilitiesCost = sumAmount(utilitiesTxns);
  const otherCost = sumAmount(operatingTxns) + sumAmount(otherTxns);

  const totalCost = materialCost + laborCost + maintenanceCost + fuelCost + utilitiesCost + otherCost;
  const margin = revenue - totalCost;
  const marginPct = revenue > 0 ? (margin / revenue) * 100 : null;

  const perM3 = (n: number) => (totalVolumeM3 > 0 ? n / totalVolumeM3 : null);

  return {
    totalVolumeM3,
    revenue,
    materialCost,
    laborCost,
    maintenanceCost,
    fuelCost,
    utilitiesCost,
    otherCost,
    totalCost,
    margin,
    marginPct,
    revenuePerM3: perM3(revenue),
    costPerM3: perM3(totalCost),
    marginPerM3: perM3(margin),
    pricedComponents,
    unpricedComponents,
  };
}

export async function getReturnsReport({ from, to, siteId, plantId }: ReportFilter) {
  const scope = tripPlantScopeWhere(siteId, plantId);
  const returns = await prisma.drumReturn.findMany({
    where: { trip: { dischargeEnd: { gte: from, lte: to }, ...scope } },
    include: {
      trip: { include: { truck: true, driver: true, batchTicket: { include: { mix: true, reservation: { include: { project: { include: { customer: true } } } } } } } },
      wasteMemo: { include: { approvedBy: true } },
    },
    orderBy: { trip: { dischargeEnd: "asc" } },
  });
  const totalReturnedM3 = returns.reduce((sum, r) => sum + r.returnedVolumeM3, 0);
  // Physically wasted (dumped) — the return's FATE, not its billing
  // DISPOSITION. A quality-rejected load is always billed NO_CHARGE
  // (see closeTripWithReturn) but still gets physically dumped just like
  // a FULL_WASTE (drum-timer-exceeded) return; disposition alone missed
  // that case entirely.
  const wastedM3 = returns.filter((r) => r.fate === "DUMPED").reduce((sum, r) => sum + r.returnedVolumeM3, 0);
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

  // Distinct from reclaimedM3 above (volume flagged reclaimable) — this is
  // volume actually topped up and reused in a later load (see
  // Trip.reclaimedVolumeM3, set by startTrip via getAvailableReclaimForTruck),
  // i.e. materials that never had to be freshly batched at all.
  const reclaimedAndReusedTrips = await prisma.trip.findMany({
    where: { reclaimedVolumeM3: { not: null }, dischargeEnd: { gte: from, lte: to }, ...tripPlantScopeWhere(siteId, plantId) },
    select: { reclaimedVolumeM3: true },
  });
  const reclaimedAndReusedM3 = reclaimedAndReusedTrips.reduce((sum, t) => sum + (t.reclaimedVolumeM3 ?? 0), 0);

  return { rows: returns, totalReturnedM3, wastedM3, reclaimedM3, reclaimedAndReusedM3, returnCount: returns.length, pendingFate };
}

export async function getTripsReport({ from, to, siteId, plantId }: ReportFilter) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, ...tripPlantScopeWhere(siteId, plantId) },
    include: { truck: true, driver: true, pump: true, batchTicket: { include: { mix: true, reservation: { include: { project: { include: { customer: true } } } } } } },
    orderBy: { dischargeEnd: "asc" },
  });
  const totalDeliveredM3 = trips.reduce((sum, t) => sum + (t.volumeDeliveredM3 ?? 0), 0);
  const cycleTimes = trips.filter((t) => t.dischargeEnd).map((t) => (t.dischargeEnd!.getTime() - t.batchTime.getTime()) / 60000);
  const avgCycleTimeMin = cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null;
  return { rows: trips, totalDeliveredM3, tripCount: trips.length, avgCycleTimeMin };
}

// Deliberately ignores the siteId/plantId scope every other report here
// takes — a truck or pump is grouped by its own CODE (below), and that
// code's productivity is meant to read as one number for the asset across
// wherever it actually worked, not fragmented by whichever plant a filter
// happens to be narrowed to.
export async function getEquipmentProductivityReport({ from, to }: Pick<ReportFilter, "from" | "to">) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to } },
    include: { truck: true, pump: true },
  });

  // Grouped by equipment CODE, not the underlying row id — a truck/pump
  // that's re-registered under a different line's Truck/Pump row (rather
  // than having its existing row's plantId edited) still rolls up as one
  // asset company-wide, exactly like the on-yard fleet numbering already
  // treats it as one thing. No unique constraint on Truck/Pump.code today,
  // so this is a deliberate merge-by-business-identity, not a DB-enforced
  // one.
  const byTruck = new Map<string, { code: string; tripCount: number; volumeM3: number }>();
  const byPump = new Map<string, { code: string; tripCount: number; volumeM3: number }>();
  for (const t of trips) {
    const vol = t.volumeDeliveredM3 ?? 0;
    const truckEntry = byTruck.get(t.truck.code) ?? { code: t.truck.code, tripCount: 0, volumeM3: 0 };
    truckEntry.tripCount += 1;
    truckEntry.volumeM3 += vol;
    byTruck.set(t.truck.code, truckEntry);

    if (t.pumpId && t.pump) {
      const pumpEntry = byPump.get(t.pump.code) ?? { code: t.pump.code, tripCount: 0, volumeM3: 0 };
      pumpEntry.tripCount += 1;
      pumpEntry.volumeM3 += vol;
      byPump.set(t.pump.code, pumpEntry);
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
      select: { driverId: true, driver: { select: { name: true, code: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpOperatorId: { not: null }, ...tripScope },
      select: { pumpOperatorId: true, pumpOperatorCrew: { select: { name: true, code: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpAssistantId: { not: null }, ...tripScope },
      select: { pumpAssistantId: true, pumpAssistantCrew: { select: { name: true, code: true } }, volumeDeliveredM3: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "CEMENT" }, ...receiptScope },
      select: { driverId: true, driverName: true, driver: { select: { name: true, code: true } }, netWeightKg: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "WATER" }, ...receiptScope },
      select: { driverId: true, driverName: true, driver: { select: { name: true, code: true } }, netWeightKg: true },
    }),
  ]);

  type Row = { key: string; name: string; role: string; count: number; volumeM3: number };
  const rows: Row[] = [];

  // Grouped by the person's CODE when they have one on file — like
  // equipment above, this merges the same real person across more than
  // one site-specific Employee/PumpCrewMember registration. Falls back to
  // the row id when code is blank (an uncoded worker just doesn't merge
  // across sites, which is honest: there's no stable identity to merge on).
  function addTripGroup(items: { id: string | null; name: string | undefined; code: string | null | undefined }[], volumes: number[], role: string) {
    const byKey = new Map<string, Row>();
    items.forEach((item, i) => {
      if (!item.id || !item.name) return;
      const groupKey = item.code || item.id;
      const entry = byKey.get(groupKey) ?? { key: `${role}:${groupKey}`, name: item.name, role, count: 0, volumeM3: 0 };
      entry.count += 1;
      entry.volumeM3 += volumes[i] ?? 0;
      byKey.set(groupKey, entry);
    });
    rows.push(...byKey.values());
  }

  addTripGroup(driverTrips.map((t) => ({ id: t.driverId, name: t.driver.name, code: t.driver.code })), driverTrips.map((t) => t.volumeDeliveredM3 ?? 0), "MIXER_DRIVER");
  addTripGroup(operatorTrips.map((t) => ({ id: t.pumpOperatorId, name: t.pumpOperatorCrew?.name, code: t.pumpOperatorCrew?.code })), operatorTrips.map((t) => t.volumeDeliveredM3 ?? 0), "PUMP_OPERATOR");
  addTripGroup(assistantTrips.map((t) => ({ id: t.pumpAssistantId, name: t.pumpAssistantCrew?.name, code: t.pumpAssistantCrew?.code })), assistantTrips.map((t) => t.volumeDeliveredM3 ?? 0), "PUMP_ASSISTANT");

  function addReceiptGroup(items: { driverId: string | null; driverName: string | null; driver: { name: string; code: string | null } | null; netWeightKg: number }[], role: string) {
    const byKey = new Map<string, Row>();
    for (const r of items) {
      const name = r.driver?.name ?? r.driverName;
      if (!name) continue;
      const key = r.driver?.code || r.driverId || `name:${name}`;
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
