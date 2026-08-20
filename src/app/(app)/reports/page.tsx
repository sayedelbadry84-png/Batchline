import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SLUMP_TOLERANCE_MM = 25; // ASTM C94-style default for a 75-150mm target band; configurable in a later phase.
const SILO_MATERIAL_TYPES = new Set(["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"]);

function fmt(n: number | null, digits = 1, suffix = "") {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

export default async function ReportsPage() {
  await requirePageAccess("reports");
  const { dict } = await getDictionary();
  const m = dict.modules.reports;

  // Server-rendered snapshot at request time, not a re-rendering client
  // component — see the same pattern (and rationale) in (app)/page.tsx.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const since = new Date(nowMs - SEVEN_DAYS_MS);

  const [completedTickets, closedTrips, labResults, testBatches, silos] = await Promise.all([
    prisma.batchTicket.findMany({
      where: { status: "COMPLETE" },
      include: { components: { include: { material: true } } },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED" },
      include: { drumReturn: true, batchTicket: true },
    }),
    prisma.labResult.findMany(),
    prisma.testBatch.findMany({
      include: { trip: { include: { batchTicket: { include: { mix: true } } } } },
    }),
    prisma.silo.findMany(),
  ]);

  // --- Production ---
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
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

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.productionTitle}</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(producedToday, 1, " m³")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.producedToday}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(produced7d, 1, " m³")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.produced7d}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(avgAbsDeviation, 2, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.avgDeviation}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{completedTickets.length}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.batchesCompleted}</div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.qualityTitle}</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(cylinderPassRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.cylinderPassRate}</div>
            <div className="mt-1 text-xs text-ink-faint">{m.resultsOnFile(labResults.length)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(slumpConformanceRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.slumpConformance}</div>
            <div className="mt-1 text-xs text-ink-faint">{m.slumpBand(SLUMP_TOLERANCE_MM, slumpChecked.length)}</div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.fleetTitle}</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(returnRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.returnRate}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(avgCycleTimeMin, 0, " min")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.avgCycleTime}</div>
            <div className="mt-1 text-xs text-ink-faint">{m.cycleNote}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{closedTrips.length}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.tripsClosed}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{arrivalsTracked.length}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.arrivalsTracked}</div>
            <div className="mt-1 text-xs text-ink-faint">{m.onTimeNote}</div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.inventoryTitle}</h2>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.silo}</th>
                <th className={ui.th}>{m.col.material}</th>
                <th className={ui.th}>{m.col.currentLevel}</th>
                <th className={ui.th}>{m.col.daysOfCover}</th>
              </tr>
            </thead>
            <tbody>
              {siloRows.map((s) => (
                <tr key={s.id}>
                  <td className={`${ui.td} font-medium`}>{s.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{dict.materialTypes[s.materialType as keyof typeof dict.materialTypes] ?? s.materialType}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.currentLevelTons.toFixed(1)} t</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(s.daysOfCover, 1, " d")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">{m.inventoryNote}</p>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-border p-5 text-sm text-ink-muted">
        <b className="text-ink">{m.notShownTitle}</b> {m.notShownBody}
      </div>
    </div>
  );
}
