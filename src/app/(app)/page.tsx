import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { canAccessModule } from "@/lib/permissions";
import { getDictionary } from "@/lib/i18n";
import { detectAnomalies, type DeviationSample } from "@/lib/anomaly";
import { groupReservationsByDay, computeWeekdayAverages } from "@/lib/demand";
import { flagMaintenanceDue } from "@/lib/maintenance";
import { DemandOutlookStrip } from "@/components/DemandOutlookStrip";
import { DrumTimer } from "@/components/DrumTimer";
import { getActiveSiteId, plantScopeWhere, reservationSiteScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";
import { sumAcceptedVolumeM3 } from "@/lib/reservations";
import { invoiceAmountDue } from "@/lib/billing";

const SEVEN_DAYS = 7;
const OUTLOOK_DAYS = 7;
const CERT_WARNING_DAYS = 60;
const LIVE_OPS_LIMIT = 4;
const TRACKER_STALE_HOURS = 24;
const WEEKS_BACK_FOR_WEEKDAY_AVG = 8;

function daysUntil(date: Date, nowMs: number) {
  return Math.ceil((date.getTime() - nowMs) / (1000 * 60 * 60 * 24));
}

type AlertRow = { key: string; severity: "critical" | "warn"; label: string; href: string };

export default async function DashboardPage() {
  const user = await requirePageAccess("dashboard");
  const { dict } = await getDictionary();
  const d = dict.dashboard;
  const r = dict.modules.reports;
  const siteId = await getActiveSiteId(user);

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const outlookEnd = new Date(todayStart);
  outlookEnd.setDate(outlookEnd.getDate() + OUTLOOK_DAYS);

  const [
    plants,
    siloCount,
    mixCount,
    customerCount,
    projectCount,
    reservationCount,
    truckCount,
    silos,
    openTrips,
    completedTickets,
    upcomingReservations,
    holdReservations,
    certificates,
    sentInvoices,
    labResults,
    maintenanceTrucks,
    maintenancePumps,
  ] = await Promise.all([
    prisma.plant.findMany({ where: { ...(siteId ? { siteId } : {}) } }),
    prisma.silo.count({ where: { ...plantScopeWhere(siteId) } }),
    prisma.mixDesign.count(), // company-wide recipe library — never site-scoped, same as everywhere else
    prisma.customer.count(), // company-wide customer list — never site-scoped, same as everywhere else
    prisma.project.count(), // company-wide — a project isn't tied to any one plant, see the Project model comment
    prisma.reservation.count({ where: { ...reservationSiteScopeWhere(siteId) } }),
    prisma.truck.count({ where: { ...plantScopeWhere(siteId) } }),
    prisma.silo.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true } }),
    prisma.trip.findMany({
      where: { status: { not: "CLOSED" }, ...tripPlantScopeWhere(siteId) },
      include: { truck: true, driver: true, batchTicket: { include: { plant: true, mix: true, reservation: { include: { project: true } } } } },
      orderBy: { batchTime: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: { status: "COMPLETE", ...plantScopeWhere(siteId) },
      include: { components: { include: { material: true } } },
    }),
    prisma.reservation.findMany({
      where: { status: { in: ["REQUESTED", "CONFIRMED", "IN_PRODUCTION"] }, pourWindowStart: { gte: todayStart, lt: outlookEnd }, ...reservationSiteScopeWhere(siteId) },
      include: { batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true, trip: { select: { volumeDeliveredM3: true } } } } },
    }),
    prisma.reservation.findMany({ where: { status: "ON_HOLD", ...reservationSiteScopeWhere(siteId) }, include: { project: true } }),
    prisma.complianceCertificate.findMany({ include: { mix: true } }), // attached to MixDesign, not a site — same as Quality module
    prisma.invoice.findMany({
      where: { status: "SENT", ...plantScopeWhere(siteId) },
      include: { payments: true, creditNotes: true },
    }),
    prisma.labResult.findMany({ where: { ...(siteId ? { testBatch: { trip: tripPlantScopeWhere(siteId) } } : {}) } }),
    prisma.truck.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true, trips: { select: { batchTime: true } } } }),
    prisma.pump.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true, trips: { select: { batchTime: true } } } }),
  ]);

  // --- Silo & drum alerts (existing logic) ---
  const siloAlerts = silos
    .map((s) => ({ ...s, pct: s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0 }))
    .filter((s) => s.pct <= s.minThresholdPct)
    .sort((a, b) => a.pct - b.pct);

  const drumAlerts = openTrips
    .map((t) => ({ ...t, elapsedMin: Math.floor((nowMs - t.batchTime.getTime()) / 60000) }))
    .filter((t) => t.elapsedMin > t.batchTicket.plant.drumTimerLimitMinutes);

  // --- Preventive maintenance (src/lib/maintenance.ts) — same derive-
  // from-existing-trip-history approach as the drum/silo alerts above. ---
  const truckMaintenanceAlerts = maintenanceTrucks
    .map((t) => ({
      code: t.code,
      ...flagMaintenanceDue(
        [{ id: t.id, lastMaintenanceAt: t.lastMaintenanceAt, tripBatchTimes: t.trips.map((trip) => trip.batchTime) }],
        t.plant.maintenanceIntervalTrips,
      )[0],
    }))
    .filter((t) => t.dueForInspection);
  const pumpMaintenanceAlerts = maintenancePumps
    .map((p) => ({
      code: p.code,
      ...flagMaintenanceDue(
        [{ id: p.id, lastMaintenanceAt: p.lastMaintenanceAt, tripBatchTimes: p.trips.map((trip) => trip.batchTime) }],
        p.plant.maintenanceIntervalTrips,
      )[0],
    }))
    .filter((p) => p.dueForInspection);

  // Tracker health — an ACTIVE truck (idle ones are expected to go quiet)
  // that hasn't pinged in a day is either turned off, out of coverage, or
  // its device has failed; either way it's silently invisible to dispatch
  // until someone notices. Never pinged at all (lastPingAt null) is the
  // same "not reporting" state, just from day one instead of a recent gap.
  const staleCutoffMs = nowMs - TRACKER_STALE_HOURS * 60 * 60 * 1000;
  const trackerAlerts = maintenanceTrucks
    .filter((t) => t.status === "ACTIVE" && (!t.lastPingAt || t.lastPingAt.getTime() < staleCutoffMs))
    .map((t) => ({
      code: t.code,
      hoursSincePing: t.lastPingAt ? Math.floor((nowMs - t.lastPingAt.getTime()) / (60 * 60 * 1000)) : null,
    }));

  // --- Production sparkline + 7-day total, from the same completedTickets
  // used for anomaly detection below — one query, two views. ---
  const sparklineDays: { date: Date; volumeM3: number }[] = [];
  for (let i = SEVEN_DAYS - 1; i >= 0; i--) {
    const dayStart = new Date(todayStart);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const volumeM3 = completedTickets
      .filter((t) => t.batchCompletedAt && t.batchCompletedAt >= dayStart && t.batchCompletedAt < dayEnd)
      .reduce((sum, t) => sum + t.volumeM3, 0);
    sparklineDays.push({ date: dayStart, volumeM3 });
  }
  const produced7d = sparklineDays.reduce((sum, day) => sum + day.volumeM3, 0);
  const sparklineMax = Math.max(...sparklineDays.map((day) => day.volumeM3), 1);

  // --- Anomaly detection — same method as Reports (src/lib/anomaly.ts). ---
  const byMaterial = new Map<string, { materialName: string; samples: DeviationSample[] }>();
  for (const ticket of completedTickets) {
    if (!ticket.batchCompletedAt) continue;
    for (const c of ticket.components) {
      if (c.actualMassKg == null) continue;
      const entry = byMaterial.get(c.materialId) ?? { materialName: c.material.name, samples: [] };
      entry.samples.push({ ticketNumber: ticket.ticketNumber, completedAt: ticket.batchCompletedAt, deviationPct: ((c.actualMassKg - c.targetMassKg) / c.targetMassKg) * 100 });
      byMaterial.set(c.materialId, entry);
    }
  }
  const anomalies = detectAnomalies(byMaterial);

  // --- Demand outlook (src/lib/demand.ts), same as Reports. Weekday
  // averages reuse completedTickets (already fetched above for the
  // sparkline/anomaly checks) rather than a separate query. ---
  const weekdayAverages = computeWeekdayAverages(
    completedTickets.filter((t) => t.batchCompletedAt).map((t) => ({ date: t.batchCompletedAt!, volumeM3: t.volumeM3 })),
    WEEKS_BACK_FOR_WEEKDAY_AVG,
    todayStart,
  );
  const demandOutlook = groupReservationsByDay(
    upcomingReservations.map((res) => ({
      pourWindowStart: res.pourWindowStart,
      remainingVolumeM3: res.requestedVolumeM3 - sumAcceptedVolumeM3(res.batchTickets),
    })),
    OUTLOOK_DAYS,
    todayStart,
    weekdayAverages,
  );

  // --- AR / quality KPIs, only computed (and shown) for roles that can
  // actually act on those modules — a Plant Operator sees production and
  // fleet context, not a customer's outstanding balance. ---
  const [canSeeBilling, canSeeQuality, canSeeReservations, canSeeProduction, canSeeEquipment, canSeeMaintenance] = await Promise.all([
    canAccessModule(user.role, "finance"),
    canAccessModule(user.role, "quality"),
    canAccessModule(user.role, "reservations"),
    canAccessModule(user.role, "production"),
    canAccessModule(user.role, "equipment"),
    canAccessModule(user.role, "maintenance"),
  ]);

  // Critical/overdue maintenance items feed the same unified alert list
  // below — same "prove it with what the app already tracks" reasoning as
  // the existing truck/pump trip-count flags, just sourced from real
  // MaintenanceTicket/MaintenancePlan rows instead of a derived count.
  const [criticalMaintenanceTickets, overdueMaintenancePlans] = canSeeMaintenance
    ? await Promise.all([
        prisma.maintenanceTicket.findMany({
          where: { status: { in: ["OPEN", "IN_PROGRESS"] }, priority: "CRITICAL", ...(siteId ? { siteId } : {}) },
          select: { id: true, equipmentLabel: true },
        }),
        prisma.maintenancePlan.findMany({
          where: { active: true, nextDueAt: { lte: new Date(nowMs) }, ...(siteId ? { siteId } : {}) },
          select: { id: true, equipmentLabel: true },
        }),
      ])
    : [[], []];

  const arOutstanding = canSeeBilling
    ? sentInvoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0)
    : 0;
  const overdueInvoiceCount = canSeeBilling ? sentInvoices.filter((inv) => inv.dueDate.getTime() < nowMs).length : 0;

  const passRate = canSeeQuality && labResults.length > 0
    ? (labResults.filter((res) => res.passFail === "PASS").length / labResults.length) * 100
    : null;

  // --- Unified alert feed: every warning scattered across Silos, Trips,
  // Quality, Reservations, Billing, and Reports, in one prioritized list —
  // the single-pane-of-glass this dashboard exists to be. ---
  const alerts: AlertRow[] = [];
  for (const s of siloAlerts) {
    alerts.push({ key: `silo-${s.id}`, severity: "warn", href: "/warehouses?tab=rawMaterials&sub=silos", label: `${s.name} ${d.siloAlertRest(s.plant.name, s.pct.toFixed(0), s.minThresholdPct)}` });
  }
  for (const t of drumAlerts) {
    alerts.push({ key: `drum-${t.id}`, severity: "critical", href: "/trips", label: `${t.truck.code} ${d.drumAlertRest(t.elapsedMin, t.batchTicket.plant.drumTimerLimitMinutes)}` });
  }
  if (canSeeEquipment) {
    for (const t of truckMaintenanceAlerts) {
      alerts.push({ key: `truck-maint-${t.id}`, severity: "warn", href: "/equipment?tab=mixers", label: d.alertMaintenanceDue(t.code, t.tripsSinceLastMaintenance) });
    }
    for (const p of pumpMaintenanceAlerts) {
      alerts.push({ key: `pump-maint-${p.id}`, severity: "warn", href: "/equipment?tab=pumps", label: d.alertMaintenanceDue(p.code, p.tripsSinceLastMaintenance) });
    }
    for (const t of trackerAlerts) {
      alerts.push({
        key: `tracker-${t.code}`,
        severity: "warn",
        href: "/equipment?tab=mixers",
        label: t.hoursSincePing != null ? d.alertTrackerStale(t.code, t.hoursSincePing) : d.alertTrackerNeverReported(t.code),
      });
    }
  }
  if (canSeeMaintenance) {
    for (const t of criticalMaintenanceTickets) {
      alerts.push({ key: `maint-ticket-${t.id}`, severity: "critical", href: "/maintenance", label: d.alertMaintenanceCritical(t.equipmentLabel) });
    }
    for (const p of overdueMaintenancePlans) {
      alerts.push({ key: `maint-plan-${p.id}`, severity: "warn", href: "/maintenance?tab=plans", label: d.alertMaintenancePlanOverdue(p.equipmentLabel) });
    }
  }
  if (canSeeQuality) {
    for (const c of certificates) {
      const remaining = daysUntil(c.expiryDate, nowMs);
      if (remaining < 0) alerts.push({ key: `cert-${c.id}`, severity: "critical", href: "/quality", label: d.alertCertExpired(c.mix.code) });
      else if (remaining <= CERT_WARNING_DAYS) alerts.push({ key: `cert-${c.id}`, severity: "warn", href: "/quality", label: d.alertCertExpiring(c.mix.code, remaining) });
    }
    for (const a of anomalies) {
      const label = a.type === "OUTLIER" ? r.outlierFlag(a.materialName, a.ticketNumber, a.deviationPct, a.zScore) : r.driftFlag(a.materialName, a.direction === "OVER" ? r.overLabel : r.underLabel, a.cusumPct);
      alerts.push({ key: `anomaly-${a.type}-${a.materialId}-${a.ticketNumber}`, severity: a.type === "OUTLIER" ? "critical" : "warn", href: "/reports", label });
    }
  }
  if (canSeeReservations) {
    for (const res of holdReservations) {
      alerts.push({ key: `hold-${res.id}`, severity: "warn", href: "/reservations", label: d.alertCreditHold(res.project.name) });
    }
  }
  if (canSeeBilling) {
    for (const inv of sentInvoices) {
      const overdueDays = Math.floor((nowMs - inv.dueDate.getTime()) / 86400000);
      if (overdueDays > 0 && invoiceAmountDue(inv) > 0.01) {
        alerts.push({ key: `invoice-${inv.id}`, severity: "critical", href: `/finance/invoices/${inv.id}`, label: d.alertOverdueInvoice(inv.invoiceNumber, overdueDays) });
      }
    }
  }
  alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));

  const stats = [
    { label: d.stats.plants, value: plants.length, href: "/plants" },
    { label: d.stats.silos, value: siloCount, href: "/warehouses?tab=rawMaterials&sub=silos" },
    { label: d.stats.mixDesigns, value: mixCount, href: "/mix-designs" },
    { label: d.stats.trucks, value: truckCount, href: "/equipment?tab=mixers" },
    { label: d.stats.customers, value: customerCount, href: "/customers" },
    { label: d.stats.projects, value: projectCount, href: "/customers" },
    { label: d.stats.reservations, value: reservationCount, href: "/reservations" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{d.eyebrow}</div>
          <h1 className={ui.h1}>{plants.length === 1 ? plants[0].name : d.title}</h1>
          <p className={ui.intro}>{d.intro}</p>
        </div>
        {(user.role === "PLANT_OPERATOR" || user.role === "ADMIN") && (
          <Link
            href="/operator"
            className="shrink-0 rounded-md border border-border px-3 py-2 text-sm text-ink-muted hover:bg-surface-alt"
          >
            {d.openFieldView}
          </Link>
        )}
      </header>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.alertsTitle}</h2>
        <div className="flex flex-col gap-2">
          {alerts.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm transition-colors ${
                a.severity === "critical"
                  ? "border-critical/30 bg-critical-soft text-critical hover:bg-critical-soft/70"
                  : "border-warn/30 bg-warn-soft text-warn hover:bg-warn-soft/70"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.severity === "critical" ? "bg-critical" : "bg-warn"}`} />
              {a.label}
            </Link>
          ))}
          {alerts.length === 0 && <div className={`${ui.card} text-sm text-good`}>{d.emptyAlerts}</div>}
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.kpiTitle}</h2>
        <div className="grid grid-cols-4 gap-4">
          <Link href="/reports" className={`${ui.card} block transition-shadow hover:shadow-md`}>
            <div className="font-mono text-2xl tabular">{produced7d.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{d.kpiProduction7d}</div>
            <div className="mt-2 flex h-8 items-end gap-1">
              {sparklineDays.map((day, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-accent"
                  style={{ height: `${Math.max(6, (day.volumeM3 / sparklineMax) * 100)}%` }}
                />
              ))}
            </div>
          </Link>
          {canSeeBilling && (
            <Link href="/finance?tab=billing" className={`${ui.card} block transition-shadow hover:shadow-md`}>
              <div className="font-mono text-2xl tabular" dir="ltr">{arOutstanding.toLocaleString()}</div>
              <div className="mt-1 text-sm text-ink-muted">{d.kpiArOutstanding}</div>
              {overdueInvoiceCount > 0 && <div className="mt-1 text-xs text-critical">{r.arOverdue}: {overdueInvoiceCount}</div>}
            </Link>
          )}
          {canSeeQuality && (
            <Link href="/quality" className={`${ui.card} block transition-shadow hover:shadow-md`}>
              <div className="font-mono text-2xl tabular">{passRate !== null ? `${passRate.toFixed(0)}%` : "—"}</div>
              <div className="mt-1 text-sm text-ink-muted">{d.kpiQualityPassRate}</div>
            </Link>
          )}
          <Link href="/trips" className={`${ui.card} block transition-shadow hover:shadow-md`}>
            <div className="font-mono text-2xl tabular">{openTrips.length}</div>
            <div className="mt-1 text-sm text-ink-muted">{d.kpiOpenTrips}</div>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.liveOpsTitle}</h2>
          <div className="flex flex-col gap-2">
            {openTrips.slice(0, LIVE_OPS_LIMIT).map((t) => (
              <div key={t.id} className={`${ui.card} flex items-center justify-between py-3`}>
                <div>
                  <span className="font-medium" dir="ltr">{t.truck.code}</span>
                  <span className="text-ink-muted"> · {t.driver.name}</span>
                  <div className="text-xs text-ink-muted">{t.batchTicket.reservation.project.name}</div>
                  <div className="font-mono text-xs text-ink-faint" dir="ltr">
                    {t.batchTicket.ticketNumber} · {t.batchTicket.reservation.reservationNumber} · {t.batchTicket.mix.code}
                  </div>
                  {t.batchTicket.reservation.siteLocation && (
                    <div className="text-xs text-ink-faint">{t.batchTicket.reservation.siteLocation}</div>
                  )}
                </div>
                <div className="text-end">
                  <span className={`${ui.chip} bg-surface-alt text-ink-muted mb-1 inline-block`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                  <DrumTimer batchTimeIso={t.batchTime.toISOString()} limitMinutes={t.batchTicket.plant.drumTimerLimitMinutes} />
                </div>
              </div>
            ))}
            {openTrips.length === 0 && <div className={`${ui.card} text-sm text-ink-muted`}>{d.emptyLiveOps}</div>}
            {openTrips.length > LIVE_OPS_LIMIT && (
              <Link href="/trips" className="text-sm font-medium text-accent-strong hover:underline">
                {d.moreOnTripBoard(openTrips.length - LIVE_OPS_LIMIT)}
              </Link>
            )}
          </div>
        </div>

        {canSeeProduction && (
          <DemandOutlookStrip title={r.outlookTitle} intro={r.outlookIntro} buckets={demandOutlook} countLabel={r.outlookCount} typicalLabel={r.outlookTypical} />
        )}
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.quickLinksTitle}</h2>
        <div className="grid grid-cols-4 gap-3">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className={`${ui.card} block px-4 py-3 transition-shadow hover:shadow-md`}>
              <div className="font-mono text-xl tabular">{s.value}</div>
              <div className="mt-0.5 text-xs text-ink-muted">{s.label}</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
