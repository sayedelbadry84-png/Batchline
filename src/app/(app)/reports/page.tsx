import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { detectAnomalies, type DeviationSample } from "@/lib/anomaly";
import { estimateCo2eKg } from "@/lib/carbon";
import { groupReservationsByDay, computeWeekdayAverages } from "@/lib/demand";
import { DemandOutlookStrip } from "@/components/DemandOutlookStrip";
import { PrintButton } from "@/components/PrintButton";
import { WhatsAppShareButton } from "@/components/WhatsAppShareButton";
import { CsvExportButton } from "@/components/CsvExportButton";
import { rowsToCsv } from "@/lib/csv";
import {
  getProductionReport,
  getIncomingReport,
  getConsumptionReport,
  getReturnsReport,
  getTripsReport,
  getEquipmentProductivityReport,
  getWorkerProductivityReport,
  getProfitabilityReport,
} from "@/lib/reportQueries";
import {
  aggregateIncentiveResults,
  activityForRole,
  getIncentiveSiteData,
  buildSitePricingMap,
  isReachBasedRole,
  INCENTIVE_ROLE_KEYS,
} from "@/lib/incentives";
import { markDrumReturnFate } from "../trips/actions";
import { getActiveSiteId, plantScopeWhere, reservationSiteScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";
import { sumAcceptedVolumeM3 } from "@/lib/reservations";
import { invoiceAmountDue } from "@/lib/billing";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const OUTLOOK_DAYS = 7;
const WEEKS_BACK_FOR_WEEKDAY_AVG = 8;
const SLUMP_TOLERANCE_MM = 25; // ASTM C94-style default for a 75-150mm target band; configurable in a later phase.
const SILO_MATERIAL_TYPES = new Set(["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"]);
const REPORT_TABS = ["overview", "production", "incoming", "consumption", "incentives", "returns", "trips", "equipment", "workers", "profitability"] as const;
type ReportTab = (typeof REPORT_TABS)[number];

function fmt(n: number | null, digits = 1, suffix = "") {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

// Report export bar shared by every non-overview tab: date range + Print +
// WhatsApp. `message` is the pre-built plain-text summary for that tab.
function ExportBar({
  m,
  tab,
  from,
  to,
  message,
  csv,
  csvFilename,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["reports"];
  tab: ReportTab;
  from: string;
  to: string;
  message: string;
  csv?: string;
  csvFilename?: string;
}) {
  return (
    <form action={`/reports`} className="no-print flex flex-wrap items-end gap-3">
      <input type="hidden" name="tab" value={tab} />
      <div>
        <label className={ui.label}>{m.dateFrom}</label>
        <input name="from" type="date" defaultValue={from} className={`${ui.input} w-40`} />
      </div>
      <div>
        <label className={ui.label}>{m.dateTo}</label>
        <input name="to" type="date" defaultValue={to} className={`${ui.input} w-40`} />
      </div>
      <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.applyRange}</button>
      <div className="ms-auto flex gap-2">
        {csv && csvFilename && <CsvExportButton label={m.exportCsv} filename={csvFilename} csv={csv} />}
        <PrintButton label={m.exportPdf} />
        <WhatsAppShareButton label={m.sendWhatsApp} promptLabel={m.whatsAppPrompt} message={message} />
      </div>
    </form>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string; site?: string; plant?: string }>;
}) {
  const user = await requirePageAccess("reports");
  const { dict } = await getDictionary();
  const m = dict.modules.reports;
  const { tab: tabRaw, from: fromRaw, to: toRaw, site: siteIdRaw, plant: plantIdRaw } = await searchParams;
  const tab: ReportTab = (REPORT_TABS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as ReportTab) : "overview";

  // Every role sees only its own site, except ADMIN (restrictedSiteId ===
  // null means unrestricted) — and for ADMIN, "its own site" now means
  // whatever they've picked in the sidebar's global plant selector (see
  // getActiveSiteId in src/lib/siteScope.ts), same as every other screen.
  // Non-admins can't override this via the ?site= query param — the site
  // dropdown is locked below; only the line (plant) sub-filter within it
  // stays a free choice. Site rolls up every line at that site combined;
  // a specific line narrows further to just its own numbers.
  const restrictedSiteId = await getActiveSiteId(user);
  const sites = await prisma.site.findMany({
    where: restrictedSiteId ? { id: restrictedSiteId } : {},
    orderBy: { name: "asc" },
    include: { plants: { orderBy: { name: "asc" } } },
  });
  const siteId = restrictedSiteId ?? (sites.some((s) => s.id === siteIdRaw) ? siteIdRaw : undefined);
  const plantId = siteId && sites.find((s) => s.id === siteId)?.plants.some((p) => p.id === plantIdRaw) ? plantIdRaw : undefined;
  const scope = { siteId, plantId };

  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultFrom = (() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  })();
  const rangeFrom = fromRaw || defaultFrom;
  const rangeTo = toRaw || todayIso;
  const rangeStart = new Date(`${rangeFrom}T00:00:00`);
  const rangeEnd = new Date(`${rangeTo}T23:59:59`);

  // Server-rendered snapshot at request time, not a re-rendering client
  // component — see the same pattern (and rationale) in (app)/page.tsx.
  // eslint-disable-next-line react-hooks/purity
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
    prisma.labResult.findMany({ where: { ...(siteId ? { testBatch: { trip: tripPlantScopeWhere(siteId, plantId) } } : {}) } }),
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

  // --- Data for the non-overview report tabs, only fetched for whichever
  // tab is actually open. ---
  const production = tab === "production" ? await getProductionReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  const incoming = tab === "incoming" ? await getIncomingReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  const consumption = tab === "consumption" ? await getConsumptionReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  const returnsData = tab === "returns" ? await getReturnsReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  const tripsData = tab === "trips" ? await getTripsReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  // Deliberately company-wide regardless of the site/plant filter above —
  // see the comment on getEquipmentProductivityReport itself.
  const equipmentData = tab === "equipment" ? await getEquipmentProductivityReport({ from: rangeStart, to: rangeEnd }) : null;
  const workersData = tab === "workers" ? await getWorkerProductivityReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;
  const profitability = tab === "profitability" ? await getProfitabilityReport({ from: rangeStart, to: rangeEnd, ...scope }) : null;

  const incentivesData =
    tab === "incentives"
      ? await (async () => {
          // Delegates to the exact same functions the Incentives module
          // itself uses (src/lib/incentives.ts) — this used to be a
          // separate, hand-rolled computation here that had drifted out
          // of sync with the real one (wrong site resolution for both
          // trip-count and volume-based roles), so the two screens could
          // show different numbers for the same person. Always
          // company-wide, same as the Incentives module and the
          // Equipment tab above — not scoped to the site/plant filter,
          // since a person can work more than one plant in the same
          // period (see aggregateIncentiveResults' own comment).
          //
          // Kept grouped by role, one table per job, rather than flattened
          // into one mixed list — a pump operator/assistant is priced by
          // volume poured (see isReachBasedRole / DEFAULT_INCENTIVE_METHOD
          // in src/lib/incentives.ts), so showing them next to a mixer
          // driver's trip count in the same "count" column read as if
          // everyone were priced the same way.
          const siteData = await getIncentiveSiteData();
          const byRole = await Promise.all(
            INCENTIVE_ROLE_KEYS.map(async (role) => {
              const entries = await activityForRole(role, rangeStart, rangeEnd);
              const sitePricing = buildSitePricingMap(siteData, role);
              const results = aggregateIncentiveResults(entries, sitePricing);
              const rows = results
                .map((r) => ({
                  key: `${role}:${r.id}`,
                  name: r.name,
                  tripCount: r.tripCount,
                  volumeM3: r.volumeM3,
                  siteCount: r.siteNames.length,
                  payout: r.payoutByCurrency.reduce((sum, p) => sum + p.amount, 0),
                }))
                .sort((a, b) => b.payout - a.payout);
              return { role, volumeBased: isReachBasedRole(role), rows };
            }),
          );
          const totalPayout = byRole.reduce((sum, g) => sum + g.rows.reduce((s, r) => s + r.payout, 0), 0);
          return { byRole, totalPayout };
        })()
      : null;

  const tabLabels: Record<ReportTab, string> = {
    overview: m.tabs.overview,
    production: m.tabs.production,
    incoming: m.tabs.incoming,
    consumption: m.tabs.consumption,
    incentives: m.tabs.incentives,
    returns: m.tabs.returns,
    trips: m.tabs.trips,
    equipment: m.tabs.equipment,
    workers: m.tabs.workers,
    profitability: m.tabs.profitability,
  };

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <form action="/reports" className="no-print flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value={tab} />
        <input type="hidden" name="from" value={rangeFrom} />
        <input type="hidden" name="to" value={rangeTo} />
        {restrictedSiteId === null ? (
          <div>
            <label className={ui.label}>{m.siteFilter}</label>
            <select name="site" defaultValue={siteId ?? ""} className={`${ui.select} w-48`}>
              <option value="">{m.allSites}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        ) : (
          // Locked to the caller's own site — no cross-site browsing for
          // non-admin roles. Kept as a hidden field so the line sub-filter
          // below still round-trips through the same form submit.
          <input type="hidden" name="site" value={siteId ?? ""} />
        )}
        {restrictedSiteId !== null && (
          <div>
            <label className={ui.label}>{m.siteFilter}</label>
            <div className={`${ui.input} w-48 flex items-center text-ink-muted`}>
              {sites.find((s) => s.id === siteId)?.name ?? "—"}
            </div>
          </div>
        )}
        {siteId && (
          <div>
            <label className={ui.label}>{m.lineFilter}</label>
            <select name="plant" defaultValue={plantId ?? ""} className={`${ui.select} w-40`}>
              <option value="">{m.wholeSite}</option>
              {sites.find((s) => s.id === siteId)?.plants.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.applyScope}</button>
        {tab !== "equipment" && tab !== "incentives" && (siteId || plantId) && <p className="text-xs text-ink-muted">{m.scopeNote}</p>}
        {tab === "equipment" && <p className="text-xs text-ink-muted">{m.equipmentScopeNote}</p>}
        {tab === "incentives" && <p className="text-xs text-ink-muted">{m.incentivesScopeNote}</p>}
      </form>
      {tab === "overview" && !siteId && <p className="no-print text-xs text-ink-muted">{m.overviewScopeNote}</p>}

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {REPORT_TABS.map((t) => (
          <Link
            key={t}
            href={`/reports?tab=${t}${siteId ? `&site=${siteId}` : ""}${plantId ? `&plant=${plantId}` : ""}${fromRaw ? `&from=${fromRaw}` : ""}${toRaw ? `&to=${toRaw}` : ""}`}
            className={`rounded-t-md px-3 py-2 text-sm ${
              tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {tabLabels[t]}
          </Link>
        ))}
      </div>

      {tab === "overview" && (
      <>
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

      <DemandOutlookStrip title={m.outlookTitle} intro={m.outlookIntro} buckets={demandOutlook} countLabel={m.outlookCount} typicalLabel={m.outlookTypical} />

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.anomaliesTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.anomaliesIntro}</p>
        <div className="flex flex-col gap-2">
          {anomalies.map((a, i) => (
            <div key={i} className={`${ui.card} flex items-center justify-between gap-4 py-3`}>
              <div>
                <span className={`${ui.chip} ${a.type === "OUTLIER" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"} me-2`}>
                  {a.type === "OUTLIER" ? m.outlierBadge : m.driftBadge}
                </span>
                <span className="text-sm">
                  {a.type === "OUTLIER"
                    ? m.outlierFlag(a.materialName, a.ticketNumber, a.deviationPct, a.zScore)
                    : m.driftFlag(a.materialName, a.direction === "OVER" ? m.overLabel : m.underLabel, a.cusumPct)}
                </span>
              </div>
            </div>
          ))}
          {anomalies.length === 0 && (
            <div className={`${ui.card} text-sm text-ink-muted`}>{m.emptyAnomalies}</div>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.sustainabilityTitle}</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(co2e7dKg, 0, " kg")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.co2e7d}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(co2ePerM3, 0, " kg/m³")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.co2ePerM3}</div>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-muted">{m.co2eNote}</p>
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

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.billingTitle}</h2>
        <div className="grid grid-cols-3 gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular" dir="ltr">{invoicedThisMonth.toLocaleString()}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.revenueThisMonth}</div>
            <div className="mt-1 text-xs text-ink-faint">{m.invoiceCount(invoices.filter((inv) => inv.issueDate >= monthStart).length)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular" dir="ltr">{arOutstanding.toLocaleString()}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.arOutstanding}</div>
          </div>
          <div className={ui.card}>
            <div className={`font-mono text-2xl tabular ${arOverdue > 0 ? "text-critical" : ""}`} dir="ltr">{arOverdue.toLocaleString()}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.arOverdue}</div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-border p-5 text-sm text-ink-muted">
        <b className="text-ink">{m.notShownTitle}</b> {m.notShownBody}
      </div>
      </>
      )}

      {tab === "production" && production && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.production} ${rangeFrom} → ${rangeTo}\n${m.production.totalVolume(production.totalVolumeM3.toFixed(1))}\n${m.production.ticketCount(production.ticketCount)} (${m.production.completedCount(production.completedCount)})`}
            csvFilename={`production-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Ticket", "Project", "Customer", "Customer code", "Reservation", "Mix", "Grade", "Pour location", "Volume m3", "Status", "Released", "Load time"],
              production.rows.map((t) => [
                t.ticketNumber,
                t.reservation.project.name,
                t.reservation.project.customer.legalName,
                t.reservation.project.customer.code ?? "",
                t.reservation.reservationNumber,
                t.mix.code,
                t.mix.grade,
                t.reservation.siteLocation ?? "",
                t.volumeM3,
                t.status,
                new Date(t.releasedAt).toISOString(),
                t.batchCompletedAt ? new Date(t.batchCompletedAt).toISOString() : "",
              ]),
            )}
          />
          <div className="flex gap-4">
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular">{production.totalVolumeM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.production.ticketCount(production.ticketCount)}</div>
            </div>
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular">{production.completedCount}</div>
              <div className="mt-1 text-sm text-ink-muted">{m.production.completedCount(production.completedCount)}</div>
            </div>
          </div>
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.production.col.ticket}</th>
                  <th className={ui.th}>{m.production.col.project}</th>
                  <th className={ui.th}>{m.production.col.reservation}</th>
                  <th className={ui.th}>{m.production.col.mix}</th>
                  <th className={ui.th}>{m.production.col.pourLocation}</th>
                  <th className={ui.th}>{m.production.col.volume}</th>
                  <th className={ui.th}>{m.production.col.status}</th>
                  <th className={ui.th}>{m.production.col.released}</th>
                  <th className={ui.th}>{m.production.col.loadTime}</th>
                </tr>
              </thead>
              <tbody>
                {production.rows.map((t) => (
                  <tr key={t.id}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.ticketNumber}</td>
                    <td className={ui.td}>
                      {t.reservation.project.name}
                      <div className="text-xs text-ink-muted">
                        {t.reservation.project.customer.legalName}
                        {t.reservation.project.customer.code ? ` (${t.reservation.project.customer.code})` : ""}
                      </div>
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.reservation.reservationNumber}</td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{t.mix.code}</span>
                      <div className="text-xs text-ink-muted">{t.mix.grade}</div>
                    </td>
                    <td className={`${ui.td} text-xs`}>{t.reservation.siteLocation ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.volumeM3} m³</td>
                    <td className={ui.td}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</td>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(t.releasedAt).toLocaleDateString()}</td>
                    <td className={`${ui.td} font-mono text-xs tabular`}>
                      {t.batchCompletedAt ? new Date(t.batchCompletedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
                {production.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "incoming" && incoming && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.incoming} ${rangeFrom} → ${rangeTo}\n${m.incoming.totalNetWeight(incoming.totalNetKg.toFixed(0))}\n${m.incoming.receiptCount(incoming.receiptCount)}`}
            csvFilename={`incoming-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Received", "Supplier", "Material", "Net weight kg", "PO", "QC status", "Driver"],
              incoming.rows.map((r) => [new Date(r.receivedAt).toISOString(), r.supplier.name, r.material.name, r.netWeightKg, r.poNumber ?? "", r.qcStatus, r.driver?.name ?? r.driverName ?? ""]),
            )}
          />
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{incoming.totalNetKg.toFixed(0)} kg</div>
            <div className="mt-1 text-sm text-ink-muted">{m.incoming.receiptCount(incoming.receiptCount)}</div>
          </div>
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.incoming.col.received}</th>
                  <th className={ui.th}>{m.incoming.col.supplier}</th>
                  <th className={ui.th}>{m.incoming.col.material}</th>
                  <th className={ui.th}>{m.incoming.col.netWeight}</th>
                  <th className={ui.th}>{m.incoming.col.po}</th>
                  <th className={ui.th}>{m.incoming.col.qcStatus}</th>
                  <th className={ui.th}>{m.incoming.col.driver}</th>
                </tr>
              </thead>
              <tbody>
                {incoming.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(r.receivedAt).toLocaleDateString()}</td>
                    <td className={ui.td}>{r.supplier.name}</td>
                    <td className={ui.td}>{r.material.name}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.netWeightKg.toFixed(0)} kg</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.poNumber || "—"}</td>
                    <td className={ui.td}>{dict.status[r.qcStatus as keyof typeof dict.status] ?? r.qcStatus}</td>
                    <td className={ui.td}>{r.driver?.name ?? r.driverName ?? "—"}</td>
                  </tr>
                ))}
                {incoming.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "consumption" && consumption && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.consumption} ${rangeFrom} → ${rangeTo}\n${m.consumption.ticketCount(consumption.ticketCount)}\n${consumption.rows.map((r) => `${r.materialName}: ${(r.massKg / 1000).toFixed(2)} t`).join("\n")}`}
            csvFilename={`consumption-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Material", "Type", "Mass kg", "Tickets"],
              consumption.rows.map((r) => [r.materialName, r.type, r.massKg, r.ticketCount]),
            )}
          />
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.consumption.col.material}</th>
                  <th className={ui.th}>{m.consumption.col.type}</th>
                  <th className={ui.th}>{m.consumption.col.mass}</th>
                  <th className={ui.th}>{m.consumption.col.tickets}</th>
                </tr>
              </thead>
              <tbody>
                {consumption.rows.map((r, i) => (
                  <tr key={i}>
                    <td className={`${ui.td} font-medium`}>{r.materialName}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{dict.materialTypes[r.type as keyof typeof dict.materialTypes] ?? r.type}</td>
                    <td className={`${ui.td} font-mono tabular`}>{(r.massKg / 1000).toFixed(2)} t</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.ticketCount}</td>
                  </tr>
                ))}
                {consumption.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-muted">{m.consumption.ticketCount(consumption.ticketCount)}</p>
          </div>
        </div>
      )}

      {tab === "profitability" && profitability && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.profitability} ${rangeFrom} → ${rangeTo}\n${m.profitability.revenue}: ${profitability.revenue.toLocaleString()}\n${m.profitability.totalCost}: ${profitability.totalCost.toLocaleString()}\n${m.profitability.margin}: ${profitability.margin.toLocaleString()}`}
            csvFilename={`profitability-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Metric", "Amount"],
              [
                [m.profitability.revenue, profitability.revenue],
                [m.profitability.materialCost, profitability.materialCost],
                [m.profitability.laborCost, profitability.laborCost],
                [m.profitability.maintenanceCost, profitability.maintenanceCost],
                [m.profitability.fuelCost, profitability.fuelCost],
                [m.profitability.utilitiesCost, profitability.utilitiesCost],
                [m.profitability.otherCost, profitability.otherCost],
                [m.profitability.totalCost, profitability.totalCost],
                [m.profitability.margin, profitability.margin],
              ],
            )}
          />

          {profitability.unpricedComponents > 0 && (
            <div className={`${ui.card} border-warn/40`}>
              <p className="text-sm text-warn">{m.profitability.unpricedNote(profitability.unpricedComponents)}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className={ui.card}>
              <div className="text-xs text-ink-muted">{m.profitability.revenue}</div>
              <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{profitability.revenue.toLocaleString()}</div>
            </div>
            <div className={ui.card}>
              <div className="text-xs text-ink-muted">{m.profitability.totalCost}</div>
              <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{profitability.totalCost.toLocaleString()}</div>
            </div>
            <div className={ui.card}>
              <div className="text-xs text-ink-muted">{m.profitability.margin}</div>
              <div className={`mt-1 font-mono text-2xl font-semibold ${profitability.margin >= 0 ? "text-good" : "text-critical"}`} dir="ltr">
                {profitability.margin.toLocaleString()}
              </div>
            </div>
            <div className={ui.card}>
              <div className="text-xs text-ink-muted">{m.profitability.marginPct}</div>
              <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{fmt(profitability.marginPct, 1, "%")}</div>
            </div>
          </div>

          <div className={ui.card}>
            <h2 className="mb-3 font-display text-base font-semibold">{m.profitability.costBreakdown}</h2>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.profitability.category}</th>
                  <th className={ui.th}>{m.profitability.amount}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={ui.td}>{m.profitability.materialCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.materialCost.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className={ui.td}>{m.profitability.laborCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.laborCost.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className={ui.td}>{m.profitability.maintenanceCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.maintenanceCost.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className={ui.td}>{m.profitability.fuelCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.fuelCost.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className={ui.td}>{m.profitability.utilitiesCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.utilitiesCost.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className={ui.td}>{m.profitability.otherCost}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{profitability.otherCost.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className={ui.card}>
            <h2 className="mb-3 font-display text-base font-semibold">{m.profitability.perM3}</h2>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.profitability.volume}</th>
                  <th className={ui.th}>{m.profitability.revenuePerM3}</th>
                  <th className={ui.th}>{m.profitability.costPerM3}</th>
                  <th className={ui.th}>{m.profitability.marginPerM3}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={`${ui.td} font-mono tabular`}>{profitability.totalVolumeM3.toFixed(1)} m³</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(profitability.revenuePerM3, 2)}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(profitability.costPerM3, 2)}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(profitability.marginPerM3, 2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "returns" && returnsData && (
        <div className="flex flex-col gap-4">
          <div className={`${ui.card} border-warn/40`}>
            <h2 className="mb-1 font-display text-base font-semibold">{m.returnsReport.pendingTitle}</h2>
            <p className="mb-3 text-sm text-ink-muted">{m.returnsReport.pendingIntro}</p>
            {returnsData.pendingFate.map((r) => (
              <form key={r.id} action={markDrumReturnFate} className="flex items-center gap-3 border-t border-border py-2 first:border-t-0 first:pt-0">
                <input type="hidden" name="id" value={r.id} />
                <span className="w-24 shrink-0 font-mono text-xs" dir="ltr">{r.trip.truck.code}</span>
                <span className="flex-1 text-sm text-ink-muted">{r.trip.driver.name} · {r.returnedVolumeM3} m³</span>
                <button name="fate" value="RECLAIMED" className="rounded-md border border-good bg-good-soft px-2 py-1 text-xs text-good hover:opacity-80">
                  {dict.returnFates.RECLAIMED}
                </button>
                <button name="fate" value="DUMPED" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                  {dict.returnFates.DUMPED}
                </button>
              </form>
            ))}
            {returnsData.pendingFate.length === 0 && <p className="text-sm text-ink-muted">{m.returnsReport.pendingEmpty}</p>}
          </div>

          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.returns} ${rangeFrom} → ${rangeTo}\n${m.returnsReport.totalReturned(returnsData.totalReturnedM3.toFixed(1))}\n${m.returnsReport.wasted(returnsData.wastedM3.toFixed(1))}`}
            csvFilename={`returns-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Discharged", "Truck", "Driver", "Project", "Customer", "Customer code", "Ticket", "Reservation", "Mix", "Grade", "Pour location", "Returned m3", "Disposition", "Reason", "Quality approval", "Quality finding"],
              returnsData.rows.map((r) => [
                r.trip.dischargeEnd ? new Date(r.trip.dischargeEnd).toISOString() : "",
                r.trip.truck.code,
                r.trip.driver.name,
                r.trip.batchTicket.reservation.project.name,
                r.trip.batchTicket.reservation.project.customer.legalName,
                r.trip.batchTicket.reservation.project.customer.code ?? "",
                r.trip.batchTicket.ticketNumber,
                r.trip.batchTicket.reservation.reservationNumber,
                r.trip.batchTicket.mix.code,
                r.trip.batchTicket.mix.grade,
                r.trip.batchTicket.reservation.siteLocation ?? "",
                r.returnedVolumeM3,
                r.disposition,
                r.reasonCode ?? "",
                r.reasonCode === "QUALITY_REJECTED" ? (r.wasteMemo?.status === "APPROVED" ? "APPROVED" : "PENDING") : "",
                r.wasteMemo?.approvalNote ?? "",
              ]),
            )}
          />
          <div className="flex gap-4">
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular text-good">{returnsData.reclaimedM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.reclaimed(returnsData.reclaimedM3.toFixed(1))}</div>
            </div>
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular">{returnsData.totalReturnedM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.returnCount(returnsData.returnCount)}</div>
            </div>
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular text-critical">{returnsData.wastedM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.wasted(returnsData.wastedM3.toFixed(1))}</div>
            </div>
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular text-good">{returnsData.reclaimedAndReusedM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.reclaimedAndReused}</div>
            </div>
          </div>
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.returnsReport.col.discharged}</th>
                  <th className={ui.th}>{m.returnsReport.col.truck}</th>
                  <th className={ui.th}>{m.returnsReport.col.driver}</th>
                  <th className={ui.th}>{m.returnsReport.col.project}</th>
                  <th className={ui.th}>{m.returnsReport.col.ticket}</th>
                  <th className={ui.th}>{m.returnsReport.col.reservation}</th>
                  <th className={ui.th}>{m.returnsReport.col.mix}</th>
                  <th className={ui.th}>{m.returnsReport.col.pourLocation}</th>
                  <th className={ui.th}>{m.returnsReport.col.returned}</th>
                  <th className={ui.th}>{m.returnsReport.col.disposition}</th>
                  <th className={ui.th}>{m.returnsReport.col.reason}</th>
                  <th className={ui.th}>{m.returnsReport.col.qualityApproval}</th>
                </tr>
              </thead>
              <tbody>
                {returnsData.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{r.trip.dischargeEnd ? new Date(r.trip.dischargeEnd).toLocaleDateString() : "—"}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.truck.code}</td>
                    <td className={ui.td}>{r.trip.driver.name}</td>
                    <td className={ui.td}>
                      {r.trip.batchTicket.reservation.project.name}
                      <div className="text-xs text-ink-muted">
                        {r.trip.batchTicket.reservation.project.customer.legalName}
                        {r.trip.batchTicket.reservation.project.customer.code ? ` (${r.trip.batchTicket.reservation.project.customer.code})` : ""}
                      </div>
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.batchTicket.ticketNumber}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.batchTicket.reservation.reservationNumber}</td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{r.trip.batchTicket.mix.code}</span>
                      <div className="text-xs text-ink-muted">{r.trip.batchTicket.mix.grade}</div>
                    </td>
                    <td className={`${ui.td} text-xs`}>{r.trip.batchTicket.reservation.siteLocation ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.returnedVolumeM3} m³</td>
                    <td className={ui.td}>{dict.status[r.disposition as keyof typeof dict.status] ?? r.disposition}</td>
                    <td className={ui.td}>{r.reasonCode ? (dict.returnReasons[r.reasonCode as keyof typeof dict.returnReasons] ?? r.reasonCode) : "—"}</td>
                    <td className={ui.td}>
                      {r.reasonCode === "QUALITY_REJECTED" ? (
                        <>
                          <span className={`${ui.chip} ${r.wasteMemo?.status === "APPROVED" ? "bg-good-soft text-good" : "bg-warn-soft text-warn"}`}>
                            {r.wasteMemo?.status === "APPROVED" && r.wasteMemo.approvedBy
                              ? dict.modules.production.detail.wasteMemoApproved(r.wasteMemo.approvedBy.name, new Date(r.wasteMemo.approvedAt!).toLocaleDateString())
                              : dict.modules.production.detail.wasteMemoPending}
                          </span>
                          {r.wasteMemo?.approvalNote && (
                            <div className="mt-1 max-w-xs text-xs text-ink-muted">{r.wasteMemo.approvalNote}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {returnsData.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={13}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "trips" && tripsData && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.trips} ${rangeFrom} → ${rangeTo}\n${m.tripsReport.totalDelivered(tripsData.totalDeliveredM3.toFixed(1))}\n${m.tripsReport.tripCount(tripsData.tripCount)}`}
            csvFilename={`trips-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Discharged", "Truck", "Driver", "Project", "Customer", "Customer code", "Ticket", "Reservation", "Mix", "Grade", "Pour location", "Load time", "Delivered m3"],
              tripsData.rows.map((t) => [
                t.dischargeEnd ? new Date(t.dischargeEnd).toISOString() : "",
                t.truck.code,
                t.driver.name,
                t.batchTicket.reservation.project.name,
                t.batchTicket.reservation.project.customer.legalName,
                t.batchTicket.reservation.project.customer.code ?? "",
                t.batchTicket.ticketNumber,
                t.batchTicket.reservation.reservationNumber,
                t.batchTicket.mix.code,
                t.batchTicket.mix.grade,
                t.batchTicket.reservation.siteLocation ?? "",
                t.batchTicket.batchCompletedAt ? new Date(t.batchTicket.batchCompletedAt).toISOString() : "",
                t.volumeDeliveredM3 ?? 0,
              ]),
            )}
          />
          <div className="flex gap-4">
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular">{tripsData.totalDeliveredM3.toFixed(1)} m³</div>
              <div className="mt-1 text-sm text-ink-muted">{m.tripsReport.tripCount(tripsData.tripCount)}</div>
            </div>
            <div className={ui.card}>
              <div className="font-mono text-2xl tabular">{fmt(tripsData.avgCycleTimeMin, 0)}</div>
              <div className="mt-1 text-sm text-ink-muted">{m.tripsReport.avgCycleTime(fmt(tripsData.avgCycleTimeMin, 0))}</div>
            </div>
          </div>
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.tripsReport.col.closed}</th>
                  <th className={ui.th}>{m.tripsReport.col.truck}</th>
                  <th className={ui.th}>{m.tripsReport.col.driver}</th>
                  <th className={ui.th}>{m.tripsReport.col.project}</th>
                  <th className={ui.th}>{m.tripsReport.col.ticket}</th>
                  <th className={ui.th}>{m.tripsReport.col.reservation}</th>
                  <th className={ui.th}>{m.tripsReport.col.mix}</th>
                  <th className={ui.th}>{m.tripsReport.col.pourLocation}</th>
                  <th className={ui.th}>{m.tripsReport.col.loadTime}</th>
                  <th className={ui.th}>{m.tripsReport.col.delivered}</th>
                </tr>
              </thead>
              <tbody>
                {tripsData.rows.map((t) => (
                  <tr key={t.id}>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{t.dischargeEnd ? new Date(t.dischargeEnd).toLocaleString() : "—"}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.truck.code}</td>
                    <td className={ui.td}>{t.driver.name}</td>
                    <td className={ui.td}>
                      {t.batchTicket.reservation.project.name}
                      <div className="text-xs text-ink-muted">
                        {t.batchTicket.reservation.project.customer.legalName}
                        {t.batchTicket.reservation.project.customer.code ? ` (${t.batchTicket.reservation.project.customer.code})` : ""}
                      </div>
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.ticketNumber}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.reservation.reservationNumber}</td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{t.batchTicket.mix.code}</span>
                      <div className="text-xs text-ink-muted">{t.batchTicket.mix.grade}</div>
                    </td>
                    <td className={`${ui.td} text-xs`}>{t.batchTicket.reservation.siteLocation ?? "—"}</td>
                    <td className={`${ui.td} font-mono text-xs tabular`}>
                      {t.batchTicket.batchCompletedAt ? new Date(t.batchTicket.batchCompletedAt).toLocaleString() : "—"}
                    </td>
                    <td className={`${ui.td} font-mono tabular`}>{fmt(t.volumeDeliveredM3, 1, " m³")}</td>
                  </tr>
                ))}
                {tripsData.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={10}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "equipment" && equipmentData && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.equipment} ${rangeFrom} → ${rangeTo}\n${equipmentData.trucks.map((t) => `${t.code}: ${t.tripCount} trips, ${t.volumeM3.toFixed(1)} m³`).join("\n")}`}
            csvFilename={`equipment-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Type", "Code", "Trips", "Volume m3"],
              [
                ...equipmentData.trucks.map((t) => ["Truck", t.code, t.tripCount, t.volumeM3]),
                ...equipmentData.pumps.map((p) => ["Pump", p.code, p.tripCount, p.volumeM3]),
              ],
            )}
          />
          <div className="grid grid-cols-2 gap-6">
            <div className={ui.card}>
              <h2 className="mb-3 font-display text-base font-semibold">{m.equipmentReport.trucksTitle}</h2>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.equipmentReport.col.code}</th>
                    <th className={ui.th}>{m.equipmentReport.col.trips}</th>
                    <th className={ui.th}>{m.equipmentReport.col.volume}</th>
                  </tr>
                </thead>
                <tbody>
                  {equipmentData.trucks.map((t) => (
                    <tr key={t.code}>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.code}</td>
                      <td className={`${ui.td} font-mono tabular`}>{t.tripCount}</td>
                      <td className={`${ui.td} font-mono tabular`}>{t.volumeM3.toFixed(1)} m³</td>
                    </tr>
                  ))}
                  {equipmentData.trucks.length === 0 && (
                    <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className={ui.card}>
              <h2 className="mb-3 font-display text-base font-semibold">{m.equipmentReport.pumpsTitle}</h2>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.equipmentReport.col.code}</th>
                    <th className={ui.th}>{m.equipmentReport.col.trips}</th>
                    <th className={ui.th}>{m.equipmentReport.col.volume}</th>
                  </tr>
                </thead>
                <tbody>
                  {equipmentData.pumps.map((p) => (
                    <tr key={p.code}>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.code}</td>
                      <td className={`${ui.td} font-mono tabular`}>{p.tripCount}</td>
                      <td className={`${ui.td} font-mono tabular`}>{p.volumeM3.toFixed(1)} m³</td>
                    </tr>
                  ))}
                  {equipmentData.pumps.length === 0 && (
                    <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "workers" && workersData && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.workers} ${rangeFrom} → ${rangeTo}\n${workersData.rows.map((r) => `${r.name} (${dict.modules.incentives.roleLabel[r.role as keyof typeof dict.modules.incentives.roleLabel] ?? r.role}): ${r.count}`).join("\n")}`}
            csvFilename={`workers-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Name", "Role", "Count", "Volume"],
              workersData.rows.map((r) => [r.name, dict.modules.incentives.roleLabel[r.role as keyof typeof dict.modules.incentives.roleLabel] ?? r.role, r.count, r.volumeM3]),
            )}
          />
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.workersReport.col.name}</th>
                  <th className={ui.th}>{m.workersReport.col.role}</th>
                  <th className={ui.th}>{m.workersReport.col.count}</th>
                  <th className={ui.th}>{m.workersReport.col.volume}</th>
                </tr>
              </thead>
              <tbody>
                {workersData.rows.map((r) => (
                  <tr key={r.key}>
                    <td className={`${ui.td} font-medium`}>{r.name}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{dict.modules.incentives.roleLabel[r.role as keyof typeof dict.modules.incentives.roleLabel] ?? r.role}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.count}</td>
                    <td className={`${ui.td} font-mono tabular`}>
                      {r.volumeM3.toFixed(1)} {r.role === "BULKER_DRIVER" || r.role === "WATER_TANKER_DRIVER" ? "t" : "m³"}
                    </td>
                  </tr>
                ))}
                {workersData.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "incentives" && incentivesData && (
        <div className="flex flex-col gap-4">
          <ExportBar
            m={m}
            tab={tab}
            from={rangeFrom}
            to={rangeTo}
            message={`${m.tabs.incentives} ${rangeFrom} → ${rangeTo}\n${incentivesData.byRole
              .flatMap((g) => g.rows.map((r) => `${r.name} (${dict.modules.incentives.roleLabel[g.role as keyof typeof dict.modules.incentives.roleLabel] ?? g.role}): ${r.payout.toFixed(0)}`))
              .join("\n")}`}
            csvFilename={`incentives-${rangeFrom}-${rangeTo}.csv`}
            csv={rowsToCsv(
              ["Name", "Role", "Trips", "Volume m3", "Sites", "Payout"],
              incentivesData.byRole.flatMap((g) =>
                g.rows.map((r) => [r.name, dict.modules.incentives.roleLabel[g.role as keyof typeof dict.modules.incentives.roleLabel] ?? g.role, r.tripCount, r.volumeM3, r.siteCount, r.payout]),
              ),
            )}
          />
          <p className="text-sm text-ink-muted">{m.incentivesReport.intro}</p>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular" dir="ltr">{incentivesData.totalPayout.toLocaleString()}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.incentivesReport.col.payout}</div>
          </div>
          {incentivesData.byRole.map((group) => (
            <div key={group.role} className={ui.card}>
              <h2 className="mb-1 font-display text-base font-semibold">{dict.modules.incentives.roleLabel[group.role as keyof typeof dict.modules.incentives.roleLabel] ?? group.role}</h2>
              {group.volumeBased && <p className="mb-3 text-xs text-ink-muted">{m.incentivesReport.volumeBasedNote}</p>}
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.incentivesReport.col.name}</th>
                    {group.volumeBased ? (
                      <>
                        <th className={ui.th}>{m.incentivesReport.col.volume}</th>
                        <th className={ui.th}>{m.incentivesReport.col.sites}</th>
                      </>
                    ) : (
                      <th className={ui.th}>{m.incentivesReport.col.trips}</th>
                    )}
                    <th className={ui.th}>{m.incentivesReport.col.payout}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r) => (
                    <tr key={r.key}>
                      <td className={`${ui.td} font-medium`}>{r.name}</td>
                      {group.volumeBased ? (
                        <>
                          <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)} m³</td>
                          <td className={`${ui.td} font-mono tabular`}>{r.siteCount}</td>
                        </>
                      ) : (
                        <td className={`${ui.td} font-mono tabular`}>{r.tripCount}</td>
                      )}
                      <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.payout.toLocaleString()}</td>
                    </tr>
                  ))}
                  {group.rows.length === 0 && (
                    <tr><td className={ui.td} colSpan={group.volumeBased ? 4 : 3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
