import { prisma } from "@/lib/prisma";
import { type PumpOperatorTrips } from "@/lib/incentives";
import { invoiceAmountDue } from "@/lib/billing";
import { AGING_BUCKETS, agingBucket, type AgingBucketKey } from "@/lib/aging";

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

// One row per (customer, project) pair — the same "wait / pour / total
// cycle" breakdown a delivery-cycle analytics tool would show, computed
// from the exact stage timestamps the driver app already records
// (Trip.departTime/arriveTime/dischargeStart/dischargeEnd) rather than
// anything new. A trip missing either endpoint of a given segment (an
// older trip from before a stage was tracked, or one that skipped a
// step) simply doesn't contribute to that segment's average — never
// treated as zero.
export type TripCycleBreakdownRow = {
  customerName: string;
  customerCode: string | null;
  projectName: string;
  tripCount: number;
  avgTransitMin: number | null;
  avgWaitMin: number | null;
  avgPourMin: number | null;
  avgCycleTimeMin: number | null;
};

function avgOf(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function minutesBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return (to.getTime() - from.getTime()) / 60000;
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

  const byProjectMap = new Map<
    string,
    { customerName: string; customerCode: string | null; projectName: string; transit: number[]; wait: number[]; pour: number[]; cycle: number[]; count: number }
  >();
  for (const t of trips) {
    const project = t.batchTicket.reservation.project;
    const key = project.id;
    const entry = byProjectMap.get(key) ?? {
      customerName: project.customer.legalName,
      customerCode: project.customer.code,
      projectName: project.name,
      transit: [],
      wait: [],
      pour: [],
      cycle: [],
      count: 0,
    };
    entry.count += 1;
    const transitMin = minutesBetween(t.departTime, t.arriveTime);
    const waitMin = minutesBetween(t.arriveTime, t.dischargeStart);
    const pourMin = minutesBetween(t.dischargeStart, t.dischargeEnd);
    const cycleMin = minutesBetween(t.batchTime, t.dischargeEnd);
    if (transitMin != null) entry.transit.push(transitMin);
    if (waitMin != null) entry.wait.push(waitMin);
    if (pourMin != null) entry.pour.push(pourMin);
    if (cycleMin != null) entry.cycle.push(cycleMin);
    byProjectMap.set(key, entry);
  }
  const byProject: TripCycleBreakdownRow[] = [...byProjectMap.values()]
    .map((e) => ({
      customerName: e.customerName,
      customerCode: e.customerCode,
      projectName: e.projectName,
      tripCount: e.count,
      avgTransitMin: avgOf(e.transit),
      avgWaitMin: avgOf(e.wait),
      avgPourMin: avgOf(e.pour),
      avgCycleTimeMin: avgOf(e.cycle),
    }))
    .sort((a, b) => b.tripCount - a.tripCount);

  return { rows: trips, totalDeliveredM3, tripCount: trips.length, avgCycleTimeMin, byProject };
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

// Every cylinder break within the period — the same LabResult rows the
// Overview tab's own pass-rate KPI already summarizes, surfaced here as
// individual, exportable rows instead of just the one aggregate rate.
// Only final-age (28-day-or-later) results count toward pass rate here,
// same "the early-age reading isn't the real acceptance result" reasoning
// strength-prediction.ts and the strength-anomaly detector already use —
// an early result still appears in the row list (it's real lab data),
// just excluded from the summary pass-rate figure.
const FINAL_STRENGTH_AGE_DAYS = 28;

export async function getQualityReport({ from, to, siteId, plantId }: ReportFilter) {
  const results = await prisma.labResult.findMany({
    where: {
      testedOn: { gte: from, lte: to },
      testBatch: { trip: tripPlantScopeWhere(siteId, plantId) },
    },
    include: {
      testBatch: { include: { trip: { include: { batchTicket: { include: { mix: true, reservation: { include: { project: { include: { customer: true } } } } } } } } } },
    },
    orderBy: { testedOn: "asc" },
  });

  const finalResults = results.filter((r) => r.ageDays >= FINAL_STRENGTH_AGE_DAYS);
  const passCount = finalResults.filter((r) => r.passFail === "PASS").length;
  const passRate = finalResults.length ? (passCount / finalResults.length) * 100 : null;

  return { rows: results, resultCount: results.length, finalResultCount: finalResults.length, passRate };
}

// One row per maintenance ticket reported within the period — no
// plantId to narrow by (equipment here isn't necessarily tied to one
// production line), so this respects siteId only, same posture
// getEquipmentProductivityReport's own comment explains for why it
// ignores scope entirely; this one at least has a real siteId scalar to
// filter by.
export async function getMaintenanceReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const tickets = await prisma.maintenanceTicket.findMany({
    where: { createdAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { assignedTo: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const openCount = tickets.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS").length;
  const totalDowntimeHours = tickets.reduce((sum, t) => sum + (t.downtimeHours ?? 0), 0);
  const totalCost = tickets.reduce((sum, t) => sum + (t.laborCost ?? 0) + (t.partsCost ?? 0), 0);

  return { rows: tickets, ticketCount: tickets.length, openCount, totalDowntimeHours, totalCost };
}

// ---------------------------------------------------------------------------
// Finance, Sales, Purchasing, Employees, Warehouses — the five modules whose
// own screens have no export at all (Finance/Employees) or no report tab at
// all (Sales/Purchasing/Warehouses). `from` is unused by the two aging
// reports below (aging is a snapshot as of `to`, not a range) but kept in
// the shared ReportFilter signature so every report tab's call site in
// reports/page.tsx stays uniform.
// ---------------------------------------------------------------------------

function emptyBucketTotals(): Record<AgingBucketKey, number> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])) as Record<AgingBucketKey, number>;
}

// Every SENT invoice still owed anything, as of `to` — same amount-due math
// (total minus payments minus credit notes) Billing itself uses, bucketed
// with the exact same agingBucket boundaries Finance's own Aging tab uses
// (src/lib/aging.ts), just exportable and date-anchored here instead of
// always "as of now". DRAFT/CANCELLED never count (never real receivables);
// PAID ones are excluded by the amountDue > 0 filter rather than by status,
// so an invoice marked PAID that still somehow carries a balance still
// surfaces here instead of silently vanishing.
export async function getArAgingReport({ to, siteId, plantId }: ReportFilter) {
  const invoices = await prisma.invoice.findMany({
    where: { status: "SENT", issueDate: { lte: to }, ...plantScopeWhere(siteId, plantId) },
    include: { payments: true, creditNotes: true, customer: true, project: true },
  });
  const rows = invoices
    .map((inv) => ({ ...inv, amountDue: invoiceAmountDue(inv), bucket: agingBucket(inv.dueDate, to) }))
    .filter((inv) => inv.amountDue > 0.01)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const byBucket = emptyBucketTotals();
  for (const r of rows) byBucket[r.bucket] += r.amountDue;
  const totalOutstanding = rows.reduce((sum, r) => sum + r.amountDue, 0);

  return { rows, byBucket, totalOutstanding, invoiceCount: rows.length };
}

// The AP mirror of the above — every UNPAID/PARTIALLY_PAID SupplierBill,
// bucketed the same way. No plantId scope: SupplierBill (like every other
// Finance model here) is site-level, not per-line — see getMaintenanceReport's
// own comment for the same reasoning.
export async function getApAgingReport({ to, siteId }: Pick<ReportFilter, "to" | "siteId">) {
  const bills = await prisma.supplierBill.findMany({
    where: { status: { in: ["UNPAID", "PARTIALLY_PAID"] }, billDate: { lte: to }, ...(siteId ? { siteId } : {}) },
    include: { payments: true, supplier: true, purchaseOrder: { select: { poNumber: true } } },
  });
  const rows = bills
    .map((bill) => {
      const paid = bill.payments.reduce((sum, p) => sum + p.amount, 0);
      const amountDue = Math.max(0, bill.total - paid);
      return { ...bill, amountDue, bucket: agingBucket(bill.dueDate, to) };
    })
    .filter((bill) => bill.amountDue > 0.01)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const byBucket = emptyBucketTotals();
  for (const r of rows) byBucket[r.bucket] += r.amountDue;
  const totalOutstanding = rows.reduce((sum, r) => sum + r.amountDue, 0);

  return { rows, byBucket, totalOutstanding, billCount: rows.length };
}

// Every cash movement in the period — the same CashTransaction rows the
// Finance module's own Cash tab shows on screen, here as a dated, exportable
// list with category totals. No plantId scope, same reasoning as AP aging.
export async function getCashLedgerReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const rows = await prisma.cashTransaction.findMany({
    where: { occurredAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { site: { select: { name: true } }, createdBy: { select: { name: true } } },
    orderBy: { occurredAt: "asc" },
  });
  const totalIn = rows.filter((t) => t.direction === "IN").reduce((sum, t) => sum + t.amount, 0);
  const totalOut = rows.filter((t) => t.direction === "OUT").reduce((sum, t) => sum + t.amount, 0);

  const byCategory = new Map<string, { category: string; in: number; out: number }>();
  for (const t of rows) {
    const entry = byCategory.get(t.category) ?? { category: t.category, in: 0, out: 0 };
    if (t.direction === "IN") entry.in += t.amount; else entry.out += t.amount;
    byCategory.set(t.category, entry);
  }

  return { rows, totalIn, totalOut, net: totalIn - totalOut, byCategory: Array.from(byCategory.values()), txnCount: rows.length };
}

// The sales funnel for opportunities opened within the period — a period
// view of the same pipeline the Sales dashboard shows live, plus a WON/LOST
// win rate. No plantId: Opportunity is booked at the site level (see that
// model's own comment — the specific line is a production-time decision).
export async function getSalesPipelineReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const rows = await prisma.opportunity.findMany({
    where: { createdAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { customer: true, owner: { select: { name: true } }, mix: { select: { code: true } } },
    orderBy: { createdAt: "asc" },
  });
  const wonCount = rows.filter((o) => o.status === "WON").length;
  const lostCount = rows.filter((o) => o.status === "LOST").length;
  const openCount = rows.length - wonCount - lostCount;
  const wonVolumeM3 = rows.filter((o) => o.status === "WON").reduce((sum, o) => sum + (o.estimatedVolumeM3 ?? 0), 0);
  const winRate = wonCount + lostCount > 0 ? (wonCount / (wonCount + lostCount)) * 100 : null;

  const byStatusMap = new Map<string, number>();
  for (const o of rows) byStatusMap.set(o.status, (byStatusMap.get(o.status) ?? 0) + 1);

  return {
    rows,
    opportunityCount: rows.length,
    wonCount,
    lostCount,
    openCount,
    wonVolumeM3,
    winRate,
    byStatus: Array.from(byStatusMap, ([status, count]) => ({ status, count })),
  };
}

// Every price quote issued within the period, with an acceptance
// (conversion) rate — a quote only ever becomes a real Reservation once
// accepted (see convertQuoteLineToReservation), so this is the sales
// module's own close-rate figure. Same site-only scope as the pipeline
// report above.
export async function getQuotesReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const rows = await prisma.quote.findMany({
    where: { createdAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { customer: true, preparedBy: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const acceptedCount = rows.filter((q) => q.status === "ACCEPTED").length;
  const declinedCount = rows.filter((q) => q.status === "DECLINED").length;
  const respondedCount = acceptedCount + declinedCount;
  const conversionRate = respondedCount > 0 ? (acceptedCount / respondedCount) * 100 : null;
  const totalValue = rows.reduce((sum, q) => sum + q.total, 0);
  const acceptedValue = rows.filter((q) => q.status === "ACCEPTED").reduce((sum, q) => sum + q.total, 0);

  return { rows, quoteCount: rows.length, acceptedCount, declinedCount, conversionRate, totalValue, acceptedValue };
}

// Every purchase order raised within the period, with an open/overdue count
// and value-by-supplier breakdown — the order-level view Purchasing's own
// screen doesn't have (its "Incoming" counterpart in this same module only
// covers what's actually been received). Site-only, same as PurchaseOrder's
// own scalar.
export async function getPurchaseOrdersReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const rows = await prisma.purchaseOrder.findMany({
    where: { orderDate: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { supplier: true, createdBy: { select: { name: true } } },
    orderBy: { orderDate: "asc" },
  });
  const totalValue = rows.reduce((sum, o) => sum + o.total, 0);
  const openCount = rows.filter((o) => o.status === "SENT" || o.status === "PARTIALLY_RECEIVED").length;
  const nowMs = Date.now();
  const overdueCount = rows.filter(
    (o) => o.expectedDate && o.expectedDate.getTime() < nowMs && o.status !== "RECEIVED" && o.status !== "CANCELLED",
  ).length;

  const bySupplierMap = new Map<string, { supplierName: string; orderCount: number; value: number }>();
  for (const o of rows) {
    const entry = bySupplierMap.get(o.supplierId) ?? { supplierName: o.supplier.name, orderCount: 0, value: 0 };
    entry.orderCount += 1;
    entry.value += o.total;
    bySupplierMap.set(o.supplierId, entry);
  }

  return {
    rows,
    orderCount: rows.length,
    totalValue,
    openCount,
    overdueCount,
    bySupplier: Array.from(bySupplierMap.values()).sort((a, b) => b.value - a.value),
  };
}

// One row per supplier active in the period — order count/value plus an
// on-time-delivery rate. PurchaseOrder has no explicit "fully received at"
// timestamp of its own, so `updatedAt` at the moment status flips to
// RECEIVED is used as a stand-in for that date (Prisma's own @updatedAt,
// touched on every status change) compared against `expectedDate` — an
// approximation, not a precise fulfillment log, same as this app's other
// honest-default disclosures (see e.g. carbon.ts). Supplier.leadTimeDays and
// rejectionRatePct are surfaced alongside as the two numbers already kept on
// file for each supplier, not recomputed here.
export async function getSupplierPerformanceReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const orders = await prisma.purchaseOrder.findMany({
    where: { orderDate: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
    include: { supplier: true },
  });

  type Row = {
    supplierId: string;
    supplierName: string;
    leadTimeDaysOnFile: number | null;
    rejectionRatePct: number;
    orderCount: number;
    totalValue: number;
    receivedCount: number;
    onTimeCount: number;
  };
  const bySupplier = new Map<string, Row>();
  for (const o of orders) {
    const entry =
      bySupplier.get(o.supplierId) ??
      ({
        supplierId: o.supplierId,
        supplierName: o.supplier.name,
        leadTimeDaysOnFile: o.supplier.leadTimeDays,
        rejectionRatePct: o.supplier.rejectionRatePct,
        orderCount: 0,
        totalValue: 0,
        receivedCount: 0,
        onTimeCount: 0,
      } satisfies Row);
    entry.orderCount += 1;
    entry.totalValue += o.total;
    if (o.status === "RECEIVED") {
      entry.receivedCount += 1;
      if (!o.expectedDate || o.updatedAt.getTime() <= o.expectedDate.getTime()) entry.onTimeCount += 1;
    }
    bySupplier.set(o.supplierId, entry);
  }

  const rows = Array.from(bySupplier.values())
    .map((e) => ({ ...e, onTimeRatePct: e.receivedCount > 0 ? (e.onTimeCount / e.receivedCount) * 100 : null }))
    .sort((a, b) => b.totalValue - a.totalValue);

  return { rows, supplierCount: rows.length };
}

// Daily attendance within the period — scoped by plantId/siteId through
// Employee.plantId (Employee has no siteId scalar of its own), same nested
// filter shape plantScopeWhere already uses for models with a direct
// plantId.
export async function getAttendanceReport({ from, to, siteId, plantId }: ReportFilter) {
  const rows = await prisma.attendanceRecord.findMany({
    where: {
      date: { gte: from, lte: to },
      employee: plantId ? { plantId } : siteId ? { plant: { siteId } } : {},
    },
    include: { employee: { select: { name: true, code: true, role: true } } },
    orderBy: { date: "asc" },
  });
  const byStatusMap = new Map<string, number>();
  for (const r of rows) byStatusMap.set(r.status, (byStatusMap.get(r.status) ?? 0) + 1);
  const absentCount = byStatusMap.get("ABSENT") ?? 0;
  const attendanceRate = rows.length ? ((rows.length - absentCount) / rows.length) * 100 : null;

  return { rows, recordCount: rows.length, absentCount, attendanceRate, byStatus: Array.from(byStatusMap, ([status, count]) => ({ status, count })) };
}

// Leave requests starting within the period — same employee scope as
// Attendance above.
export async function getLeaveReport({ from, to, siteId, plantId }: ReportFilter) {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      startDate: { gte: from, lte: to },
      employee: plantId ? { plantId } : siteId ? { plant: { siteId } } : {},
    },
    include: { employee: { select: { name: true, code: true, role: true } }, approvedBy: { select: { name: true } } },
    orderBy: { startDate: "asc" },
  });
  const approvedCount = rows.filter((r) => r.status === "APPROVED").length;
  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  const totalDaysApproved = rows.filter((r) => r.status === "APPROVED").reduce((sum, r) => sum + r.daysCount, 0);

  const byTypeMap = new Map<string, number>();
  for (const r of rows) byTypeMap.set(r.type, (byTypeMap.get(r.type) ?? 0) + r.daysCount);

  return { rows, requestCount: rows.length, approvedCount, pendingCount, totalDaysApproved, byType: Array.from(byTypeMap, ([type, days]) => ({ type, days })) };
}

// Payroll lines from every run whose period starts within the window —
// PayrollLine carries no site/plant scalar of its own, so scope is applied
// in JS against each line's own employee after the fact rather than in the
// Prisma where clause (a run mixes employees from more than one plant when
// the company runs payroll company-wide in one batch). totalCost mirrors
// markPayrollRunPaid's own real-cash-cost definition: net pay plus the
// employer's own GOSI share — the employee's own GOSI is already netted out
// of netPay, so adding it again here would double-count it.
export async function getPayrollCostReport({ from, to, siteId, plantId }: ReportFilter) {
  const runs = await prisma.payrollRun.findMany({
    where: { periodStart: { gte: from, lte: to } },
    include: {
      lines: {
        include: { employee: { select: { name: true, code: true, role: true, plantId: true, plant: { select: { siteId: true } } } } },
      },
    },
    orderBy: { periodStart: "asc" },
  });

  const rows = runs.flatMap((run) =>
    run.lines
      .filter((l) => (plantId ? l.employee.plantId === plantId : siteId ? l.employee.plant.siteId === siteId : true))
      .map((l) => ({ ...l, runNumber: run.runNumber, runStatus: run.status, periodStart: run.periodStart, periodEnd: run.periodEnd })),
  );

  const totalGross = rows.reduce((sum, l) => sum + l.grossPay, 0);
  const totalNet = rows.reduce((sum, l) => sum + l.netPay, 0);
  const totalEmployerGosi = rows.reduce((sum, l) => sum + l.employerGosi, 0);
  const totalIncentives = rows.reduce((sum, l) => sum + l.incentiveAmount, 0);
  const totalCost = totalNet + totalEmployerGosi;

  return { rows, lineCount: rows.length, totalGross, totalNet, totalEmployerGosi, totalIncentives, totalCost };
}

// Spare-parts receipts and issuances within the period, plus each touched
// part's all-time balance as of `to` — same derivation the Warehouses
// module's own Spare Parts tab uses (sum of SparePartReceipt.quantity minus
// sum of MaintenanceOrderPart.quantity minus sum of
// SparePartIssuance.quantity — a part can leave the shelf against a
// maintenance order OR as a direct warehouse issuance, both count —
// keyed by sparePartId+site; see that tab's own comment), computed here
// rather than imported since the tab's version isn't date-ranged. No
// plantId: spare parts are a site-level warehouse, not per-line.
export async function getSparePartsReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const [receipts, orderIssuances, directIssuances, allReceiptsForBalance, allOrderIssuancesForBalance, allDirectIssuancesForBalance] = await Promise.all([
    prisma.sparePartReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
      include: { sparePart: true, site: { select: { name: true } }, supplier: { select: { name: true } }, receivedBy: { select: { name: true } } },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.maintenanceOrderPart.findMany({
      where: { issuedAt: { gte: from, lte: to } },
      include: { sparePart: true, order: { include: { ticket: { select: { siteId: true } } } }, issuedBy: { select: { name: true } } },
      orderBy: { issuedAt: "asc" },
    }),
    prisma.sparePartIssuance.findMany({
      where: { issuedAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
      include: { sparePart: true, site: { select: { name: true } }, issuedBy: { select: { name: true } } },
      orderBy: { issuedAt: "asc" },
    }),
    prisma.sparePartReceipt.findMany({ select: { sparePartId: true, siteId: true, quantity: true } }),
    prisma.maintenanceOrderPart.findMany({ select: { sparePartId: true, quantity: true, order: { select: { ticket: { select: { siteId: true } } } } } }),
    prisma.sparePartIssuance.findMany({ select: { sparePartId: true, siteId: true, quantity: true } }),
  ]);
  const orderIssuancesInScope = siteId ? orderIssuances.filter((i) => i.order.ticket.siteId === siteId) : orderIssuances;

  const inQty = new Map<string, number>();
  for (const r of allReceiptsForBalance) inQty.set(`${r.sparePartId}::${r.siteId}`, (inQty.get(`${r.sparePartId}::${r.siteId}`) ?? 0) + r.quantity);
  const outQty = new Map<string, number>();
  for (const p of allOrderIssuancesForBalance) {
    const key = `${p.sparePartId}::${p.order.ticket.siteId}`;
    outQty.set(key, (outQty.get(key) ?? 0) + p.quantity);
  }
  for (const i of allDirectIssuancesForBalance) {
    const key = `${i.sparePartId}::${i.siteId}`;
    outQty.set(key, (outQty.get(key) ?? 0) + i.quantity);
  }
  const touchedKeys = new Set([
    ...receipts.map((r) => `${r.sparePartId}::${r.siteId}`),
    ...orderIssuancesInScope.map((i) => `${i.sparePartId}::${i.order.ticket.siteId}`),
    ...directIssuances.map((i) => `${i.sparePartId}::${i.siteId}`),
  ]);
  const balances = Array.from(touchedKeys, (key) => {
    const [sparePartId] = key.split("::");
    const part =
      receipts.find((r) => r.sparePartId === sparePartId)?.sparePart ??
      orderIssuancesInScope.find((i) => i.sparePartId === sparePartId)?.sparePart ??
      directIssuances.find((i) => i.sparePartId === sparePartId)?.sparePart;
    return { key, partCode: part?.code ?? sparePartId, partName: part?.name ?? "", balance: (inQty.get(key) ?? 0) - (outQty.get(key) ?? 0) };
  }).sort((a, b) => a.partCode.localeCompare(b.partCode));

  const totalReceivedValue = receipts.reduce((sum, r) => sum + r.quantity * r.unitCost, 0);
  const totalIssuedValue = orderIssuancesInScope.reduce((sum, i) => sum + i.lineTotal, 0) + directIssuances.reduce((sum, i) => sum + i.quantity * i.unitCost, 0);
  const issuanceCount = orderIssuancesInScope.length + directIssuances.length;
  const lowStockCount = balances.filter((b) => b.balance <= 0).length;

  return { receipts, issuances: orderIssuancesInScope, directIssuances, balances, receiptCount: receipts.length, issuanceCount, totalReceivedValue, totalIssuedValue, lowStockCount };
}

// The Finished Goods equivalent of the Spare Parts report above — IN
// (produced) vs OUT (shipped/sold/consumed) movements in the period, plus
// each touched product's all-time balance as of `to`, same derived-balance
// convention as the Warehouses module's own Finished Goods tab.
export async function getFinishedGoodsReport({ from, to, siteId }: Pick<ReportFilter, "from" | "to" | "siteId">) {
  const [movements, allMovementsForBalance] = await Promise.all([
    prisma.finishedProductMovement.findMany({
      where: { occurredAt: { gte: from, lte: to }, ...(siteId ? { siteId } : {}) },
      include: { product: true, site: { select: { name: true } }, recordedBy: { select: { name: true } } },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.finishedProductMovement.findMany({ select: { productId: true, siteId: true, direction: true, quantity: true } }),
  ]);

  const netQty = new Map<string, number>();
  for (const mv of allMovementsForBalance) {
    const key = `${mv.productId}::${mv.siteId}`;
    netQty.set(key, (netQty.get(key) ?? 0) + (mv.direction === "IN" ? mv.quantity : -mv.quantity));
  }
  const touchedKeys = new Set(movements.map((mv) => `${mv.productId}::${mv.siteId}`));
  const balances = Array.from(touchedKeys, (key) => {
    const [productId] = key.split("::");
    const product = movements.find((mv) => mv.productId === productId)?.product;
    return { key, productCode: product?.code ?? productId, productName: product?.name ?? "", balance: netQty.get(key) ?? 0 };
  }).sort((a, b) => a.productCode.localeCompare(b.productCode));

  const producedQty = movements.filter((mv) => mv.direction === "IN").reduce((sum, mv) => sum + mv.quantity, 0);
  const shippedQty = movements.filter((mv) => mv.direction === "OUT").reduce((sum, mv) => sum + mv.quantity, 0);

  return { rows: movements, balances, movementCount: movements.length, producedQty, shippedQty };
}

// Factory Performance Analysis (P/QM/006 attachment) — the real paper form
// tracks, per product, per quarter: production cost, sales volume, returns/
// unsold quantity, customer count, and worker count. Batchline has no
// single "product" dimension that spans both ready-mix (delivered by the
// m³, never held as inventory) and finished goods like block (held and
// shipped by the unit), so rather than force those into one row this
// rolls the same five KPIs up company/plant-wide per calendar quarter,
// reusing the existing Profitability/Production/Returns/FinishedGoods/
// Attendance reports instead of recomputing any of their logic — a
// convenience quarterly summary, not a compliance record, so nothing here
// is persisted.
export async function getFactoryPerformanceReport({ from, to, siteId, plantId }: ReportFilter) {
  const quarters: { label: string; start: Date; end: Date }[] = [];
  let cursor = new Date(from.getFullYear(), Math.floor(from.getMonth() / 3) * 3, 1);
  while (cursor <= to) {
    const quarterEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 0, 23, 59, 59, 999);
    const start = cursor.getTime() > from.getTime() ? cursor : from;
    const end = quarterEnd.getTime() < to.getTime() ? quarterEnd : to;
    const q = Math.floor(cursor.getMonth() / 3) + 1;
    quarters.push({ label: `${cursor.getFullYear()} Q${q}`, start, end });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1);
  }

  const rows = await Promise.all(
    quarters.map(async (q) => {
      const range = { from: q.start, to: q.end, siteId, plantId };
      const [profitability, production, returns, finishedGoods, attendance] = await Promise.all([
        getProfitabilityReport(range),
        getProductionReport(range),
        getReturnsReport(range),
        getFinishedGoodsReport({ from: q.start, to: q.end, siteId }),
        getAttendanceReport(range),
      ]);
      const customerIds = new Set(
        production.rows.map((t) => t.reservation?.project?.customer?.id).filter((id): id is string => !!id),
      );
      const workerIds = new Set(attendance.rows.map((r) => r.employeeId));

      return {
        label: q.label,
        productionCost: profitability.totalCost,
        concreteVolumeM3: production.totalVolumeM3,
        finishedGoodsShippedQty: finishedGoods.shippedQty,
        returnedVolumeM3: returns.totalReturnedM3,
        customerCount: customerIds.size,
        workerCount: workerIds.size,
      };
    }),
  );

  return { rows };
}
