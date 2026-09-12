// The Overview tab's data. It lived inline in reports/page.tsx until
// 2026-09-12, where it ran on EVERY tab — six parallel queries plus the
// reservation pipeline — even though nothing outside the Overview markup
// ever read a single one of its results. Pulling it out into a function
// the page calls only for `tab === "overview"` is what finally makes that
// conditional, the same way all twenty-four other tabs already were.
import "server-only";
import { prisma } from "@/lib/prisma";
import { detectAnomalies, detectStrengthAnomalies, type DeviationSample, type StrengthDeviationSample } from "@/lib/anomaly";
import { estimateCo2eKg } from "@/lib/carbon";
import { groupReservationsByDay, computeWeekdayAverages } from "@/lib/demand";
import { plantScopeWhere, reservationSiteScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";
import { sumAcceptedVolumeM3 } from "@/lib/reservations";
import { invoiceAmountDue } from "@/lib/billing";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTLOOK_DAYS = 7;
export const WEEKS_BACK_FOR_WEEKDAY_AVG = 8;
export const SLUMP_TOLERANCE_MM = 25; // ASTM C94-style default for a 75-150mm target band; configurable in a later phase.
export const FINAL_STRENGTH_AGE_DAYS = 28; // The real acceptance age — 3/7/14-day results are early-age diagnostics, not the final result.
export const SILO_MATERIAL_TYPES = new Set(["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"]);

export async function getOverviewReport({ siteId, plantId }: { siteId?: string; plantId?: string }) {
  // Server-rendered snapshot at request time, not a re-rendering client
  // component — see the same pattern (and rationale) in (app)/page.tsx.
  // (The react-hooks/purity disable this line used to carry is gone with
  // the move: the call is no longer inside a component body.)
  const nowMs = Date.now();
  const since = new Date(nowMs - SEVEN_DAYS_MS);

  // Overview now respects the same site/line drilldown as every other tab
  // (siteId/plantId above, already capped to the caller's own site for a
  // non-admin) — it used to ignore that filter entirely and always show
  // every site combined, which read as a bug the moment someone actually
  // picked a specific plant here and saw company-wide numbers anyway.
  const [completedTickets, closedTrips, labResults, testBatches, silos, invoices] = await Promise.all([
    prisma.batchTicket.findMany({
      where: { status: "COMPLETE", ...plantScopeWhere(siteId, plantId) },
      include: { components: { include: { material: true } } },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", ...tripPlantScopeWhere(siteId, plantId) },
      include: { drumReturn: true, batchTicket: true },
    }),
    prisma.labResult.findMany({
      where: { ...(siteId ? { testBatch: { trip: tripPlantScopeWhere(siteId, plantId) } } : {}) },
      include: { testBatch: { include: { trip: { include: { batchTicket: { include: { mix: true } } } } } } },
    }),
    prisma.testBatch.findMany({
      where: { ...(siteId ? { trip: tripPlantScopeWhere(siteId, plantId) } : {}) },
      include: { trip: { include: { batchTicket: { include: { mix: true } } } } },
    }),
    prisma.silo.findMany({ where: { ...plantScopeWhere(siteId, plantId) } }),
    prisma.invoice.findMany({
      where: { status: { not: "CANCELLED" }, ...plantScopeWhere(siteId, plantId) },
      include: { payments: true, creditNotes: true },
    }),
  ]);

  // --- Production ---
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const outlookEnd = new Date(todayStart);
  outlookEnd.setDate(outlookEnd.getDate() + OUTLOOK_DAYS);

  // --- Demand outlook: the confirmed reservation pipeline for the next 7
  // days — real committed demand, not a statistical guess (there isn't
  // enough order history yet to fit one honestly). Volume already
  // released as batch tickets is netted out, same split-batch accounting
  // the Reservations screen itself uses. ---
  const upcomingReservations = await prisma.reservation.findMany({
    where: {
      status: { in: ["REQUESTED", "CONFIRMED", "IN_PRODUCTION"] },
      pourWindowStart: { gte: todayStart, lt: outlookEnd },
      ...reservationSiteScopeWhere(siteId),
    },
    include: { batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true, trip: { select: { volumeDeliveredM3: true } } } } },
  });
  const weekdayAverages = computeWeekdayAverages(
    completedTickets.filter((t) => t.batchCompletedAt).map((t) => ({ date: t.batchCompletedAt!, volumeM3: t.volumeM3 })),
    WEEKS_BACK_FOR_WEEKDAY_AVG,
    todayStart,
  );
  const demandOutlook = groupReservationsByDay(
    upcomingReservations.map((r) => ({
      pourWindowStart: r.pourWindowStart,
      remainingVolumeM3: r.requestedVolumeM3 - sumAcceptedVolumeM3(r.batchTickets),
    })),
    OUTLOOK_DAYS,
    todayStart,
    weekdayAverages,
  );
  const producedToday = completedTickets
    .filter((t) => t.batchCompletedAt && t.batchCompletedAt >= todayStart)
    .reduce((sum, t) => sum + t.volumeM3, 0);
  const produced7d = completedTickets
    .filter((t) => t.batchCompletedAt && t.batchCompletedAt >= since)
    .reduce((sum, t) => sum + t.volumeM3, 0);

  // --- Batch accuracy ---
  const weighedComponents = completedTickets.flatMap((t) => t.components).filter((c) => c.actualMassKg != null);
  const deviations = weighedComponents.map((c) => Math.abs(((c.actualMassKg! - c.targetMassKg) / c.targetMassKg) * 100));
  const avgAbsDeviation = deviations.length ? deviations.reduce((a, b) => a + b, 0) / deviations.length : null;

  // --- Sustainability: embodied CO2e from what was actually batched
  // (actual mass where weighed, target where not) in the last 7 days —
  // same generic published factors as the per-mix estimate on Mix Design,
  // applied here to real production instead of a design recipe. ---
  const co2e7dKg = completedTickets
    .filter((t) => t.batchCompletedAt && t.batchCompletedAt >= since)
    .flatMap((t) => t.components)
    .reduce((sum, c) => sum + estimateCo2eKg(c.material.type, c.actualMassKg ?? c.targetMassKg, c.material.co2FactorKgPerKg), 0);
  const co2ePerM3 = produced7d > 0 ? co2e7dKg / produced7d : null;

  // --- Anomaly detection: statistical outliers + directional drift per
  // material, over the same weighed-component data the deviation average
  // above already uses (see src/lib/anomaly.ts for the method). ---
  const byMaterial = new Map<string, { materialName: string; samples: DeviationSample[] }>();
  for (const ticket of completedTickets) {
    if (!ticket.batchCompletedAt) continue;
    for (const c of ticket.components) {
      if (c.actualMassKg == null) continue;
      const entry = byMaterial.get(c.materialId) ?? { materialName: c.material.name, samples: [] };
      entry.samples.push({
        ticketNumber: ticket.ticketNumber,
        completedAt: ticket.batchCompletedAt,
        deviationPct: ((c.actualMassKg - c.targetMassKg) / c.targetMassKg) * 100,
      });
      byMaterial.set(c.materialId, entry);
    }
  }
  const anomalies = detectAnomalies(byMaterial);

  // --- Strength anomalies: the same engine applied to cylinder-strength
  // margin over target, one sample per mix design per final-age (28-day
  // or later) LabResult. Early-age (3/7/14-day) results are diagnostic,
  // not the real acceptance result — strength-prediction.ts already
  // covers those — so they're excluded here rather than mixed into a
  // population they'd distort. ---
  const byMix = new Map<string, { mixCode: string; samples: StrengthDeviationSample[] }>();
  for (const r of labResults) {
    if (r.ageDays < FINAL_STRENGTH_AGE_DAYS) continue;
    const mix = r.testBatch.trip.batchTicket.mix;
    const entry = byMix.get(mix.id) ?? { mixCode: mix.code, samples: [] };
    entry.samples.push({
      testRef: r.testBatch.trip.batchTicket.ticketNumber,
      testedOn: r.testedOn,
      deviationPct: ((r.breakStrengthMpa - r.targetStrengthMpa) / r.targetStrengthMpa) * 100,
    });
    byMix.set(mix.id, entry);
  }
  const strengthAnomalies = detectStrengthAnomalies(byMix);

  // --- Quality ---
  const passCount = labResults.filter((r) => r.passFail === "PASS").length;
  const cylinderPassRate = labResults.length ? (passCount / labResults.length) * 100 : null;

  const slumpChecked = testBatches.filter((tb) => tb.slumpMeasuredMm != null);
  const slumpConforming = slumpChecked.filter(
    (tb) => Math.abs(tb.slumpMeasuredMm! - tb.trip.batchTicket.mix.slumpTargetMm) <= SLUMP_TOLERANCE_MM,
  );
  const slumpConformanceRate = slumpChecked.length ? (slumpConforming.length / slumpChecked.length) * 100 : null;

  // --- Fleet & logistics ---
  const totalDelivered = closedTrips.reduce((sum, t) => sum + (t.volumeDeliveredM3 ?? 0), 0);
  const totalReturned = closedTrips.reduce((sum, t) => sum + (t.drumReturn?.returnedVolumeM3 ?? 0), 0);
  const returnRate = totalDelivered + totalReturned > 0 ? (totalReturned / (totalDelivered + totalReturned)) * 100 : null;

  const cycleTimes = closedTrips
    .filter((t) => t.dischargeEnd)
    .map((t) => (t.dischargeEnd!.getTime() - t.batchTime.getTime()) / 60000);
  const avgCycleTimeMin = cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null;

  const arrivalsTracked = closedTrips.filter((t) => t.arriveTime);
  // No scheduled arrival time is modeled independently of the pour window yet
  // (Reservation isn't loaded here) — this is an approximation, noted below.

  // --- Silo days-of-cover ---
  const consumptionByType = new Map<string, number>();
  for (const ticket of completedTickets) {
    if (!ticket.batchCompletedAt || ticket.batchCompletedAt < since) continue;
    for (const c of ticket.components) {
      if (!SILO_MATERIAL_TYPES.has(c.material.type)) continue;
      const massKg = c.actualMassKg ?? c.targetMassKg;
      consumptionByType.set(c.material.type, (consumptionByType.get(c.material.type) ?? 0) + massKg);
    }
  }
  const siloRows = silos.map((s) => {
    const consumedKg7d = consumptionByType.get(s.materialType) ?? 0;
    const dailyTons = consumedKg7d / 1000 / 7;
    const daysOfCover = dailyTons > 0 ? s.currentLevelTons / dailyTons : null;
    return { ...s, daysOfCover };
  });

  // --- Billing (revenue currently invoiced, AR outstanding/overdue) ---
  const monthStart = new Date(nowMs);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const invoicedThisMonth = invoices
    .filter((inv) => inv.issueDate >= monthStart)
    .reduce((sum, inv) => sum + inv.total, 0);

  const sentInvoices = invoices.filter((inv) => inv.status === "SENT");
  const arOutstanding = sentInvoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);
  const arOverdue = sentInvoices
    .filter((inv) => inv.dueDate.getTime() < nowMs)
    .reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);

  return {
    anomalies,
    arOutstanding,
    arOverdue,
    arrivalsTracked,
    avgAbsDeviation,
    avgCycleTimeMin,
    closedTrips,
    co2e7dKg,
    co2ePerM3,
    completedTickets,
    cylinderPassRate,
    demandOutlook,
    invoicedThisMonth,
    invoices,
    labResults,
    monthStart,
    produced7d,
    producedToday,
    returnRate,
    siloRows,
    slumpChecked,
    slumpConformanceRate,
    strengthAnomalies,
  };
}
