import { prisma } from "@/lib/prisma";

// One function per exportable report in the Reports module — each takes a
// plain date range and returns rows plus whatever summary numbers its own
// page needs. Kept here rather than inline in page.tsx so the same query
// can be reused by both the on-screen table and (eventually) any other
// consumer without re-deriving the aggregation logic.

export type DateRange = { from: Date; to: Date };

export async function getProductionReport({ from, to }: DateRange) {
  const tickets = await prisma.batchTicket.findMany({
    where: { releasedAt: { gte: from, lte: to } },
    include: { mix: true, reservation: { include: { project: { include: { customer: true } } } }, plant: true },
    orderBy: { releasedAt: "asc" },
  });
  const totalVolumeM3 = tickets.reduce((sum, t) => sum + t.volumeM3, 0);
  const completedCount = tickets.filter((t) => t.status === "COMPLETE").length;
  return { rows: tickets, totalVolumeM3, ticketCount: tickets.length, completedCount };
}

export async function getIncomingReport({ from, to }: DateRange) {
  const receipts = await prisma.materialReceipt.findMany({
    where: { receivedAt: { gte: from, lte: to } },
    include: { supplier: true, material: true, plant: true, driver: true },
    orderBy: { receivedAt: "asc" },
  });
  const totalNetKg = receipts.reduce((sum, r) => sum + r.netWeightKg, 0);
  return { rows: receipts, totalNetKg, receiptCount: receipts.length };
}

export async function getConsumptionReport({ from, to }: DateRange) {
  const tickets = await prisma.batchTicket.findMany({
    where: { status: "COMPLETE", batchCompletedAt: { gte: from, lte: to } },
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

export async function getReturnsReport({ from, to }: DateRange) {
  const returns = await prisma.drumReturn.findMany({
    where: { trip: { dischargeEnd: { gte: from, lte: to } } },
    include: { trip: { include: { truck: true, driver: true, batchTicket: { include: { reservation: { include: { project: true } } } } } } },
    orderBy: { trip: { dischargeEnd: "asc" } },
  });
  const totalReturnedM3 = returns.reduce((sum, r) => sum + r.returnedVolumeM3, 0);
  const wastedM3 = returns.filter((r) => r.disposition === "FULL_WASTE").reduce((sum, r) => sum + r.returnedVolumeM3, 0);
  return { rows: returns, totalReturnedM3, wastedM3, returnCount: returns.length };
}

export async function getTripsReport({ from, to }: DateRange) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to } },
    include: { truck: true, driver: true, pump: true, batchTicket: { include: { reservation: { include: { project: true } } } } },
    orderBy: { dischargeEnd: "asc" },
  });
  const totalDeliveredM3 = trips.reduce((sum, t) => sum + (t.volumeDeliveredM3 ?? 0), 0);
  const cycleTimes = trips.filter((t) => t.dischargeEnd).map((t) => (t.dischargeEnd!.getTime() - t.batchTime.getTime()) / 60000);
  const avgCycleTimeMin = cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null;
  return { rows: trips, totalDeliveredM3, tripCount: trips.length, avgCycleTimeMin };
}

export async function getEquipmentProductivityReport({ from, to }: DateRange) {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to } },
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
export async function getWorkerProductivityReport({ from, to }: DateRange) {
  const [driverTrips, operatorTrips, assistantTrips, bulkerReceipts, waterReceipts] = await Promise.all([
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to } },
      select: { driverId: true, driver: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpOperatorId: { not: null } },
      select: { pumpOperatorId: true, pumpOperatorCrew: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", dischargeEnd: { gte: from, lte: to }, pumpAssistantId: { not: null } },
      select: { pumpAssistantId: true, pumpAssistantCrew: { select: { name: true } }, volumeDeliveredM3: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "CEMENT" } },
      select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true },
    }),
    prisma.materialReceipt.findMany({
      where: { receivedAt: { gte: from, lte: to }, material: { type: "WATER" } },
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
