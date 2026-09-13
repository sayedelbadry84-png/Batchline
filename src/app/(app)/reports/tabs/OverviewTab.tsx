// Extracted from reports/page.tsx on 2026-09-12. The markup is
// byte-identical to what lived there; the values it reads now arrive as
// one `overview` object from ./overviewReport instead of from a hundred
// and eighty lines of computation in the page function's own body.
import { DemandOutlookStrip } from "@/components/DemandOutlookStrip";
import { ui } from "@/lib/ui";
import { fmt, type ReportTabContext } from "../reportUi";
import { SLUMP_TOLERANCE_MM, getOverviewReport } from "../overviewReport";

export function OverviewTab({ overview, ctx }: {
  overview: NonNullable<Awaited<ReturnType<typeof getOverviewReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict } = ctx;
  const m = dict.modules.reports;
  const {
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
  } = overview;
  return (
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
      <div className="mt-4">
        <p className="mb-2 text-sm text-ink-muted">{m.strengthAnomaliesIntro}</p>
        <div className="flex flex-col gap-2">
          {strengthAnomalies.map((a, i) => (
            <div key={i} className={`${ui.card} flex items-center justify-between gap-4 py-3`}>
              <div>
                <span className={`${ui.chip} ${a.type === "OUTLIER" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"} me-2`}>
                  {a.type === "OUTLIER" ? m.outlierBadge : m.driftBadge}
                </span>
                <span className="text-sm">
                  {a.type === "OUTLIER"
                    ? m.strengthOutlierFlag(a.mixCode, a.testRef, a.deviationPct, a.zScore)
                    : m.strengthDriftFlag(a.mixCode, a.direction === "OVER" ? m.overLabel : m.underLabel, a.cusumPct)}
                </span>
              </div>
            </div>
          ))}
          {strengthAnomalies.length === 0 && (
            <div className={`${ui.card} text-sm text-ink-muted`}>{m.emptyAnomalies}</div>
          )}
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
  );
}
