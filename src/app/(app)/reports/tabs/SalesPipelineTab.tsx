// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getSalesPipelineReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function SalesPipelineTab({ salesPipelineData, ctx }: {
  salesPipelineData: NonNullable<Awaited<ReturnType<typeof getSalesPipelineReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="salesPipeline"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.salesPipeline} ${rangeFrom} → ${rangeTo}\n${m.salesPipelineReport.opportunityCount(salesPipelineData.opportunityCount)}\n${salesPipelineData.winRate === null ? "" : `${m.salesPipelineReport.winRateLabel}: ${salesPipelineData.winRate.toFixed(1)}%`}`}
          filenameBase={`sales-pipeline-${rangeFrom}-${rangeTo}`}
          headers={["Number", "Customer/Prospect", "Mix", "Est. volume m3", "Status", "Owner", "Expected close", "Created"]}
          rows={salesPipelineData.rows.map((o) => [
            o.opportunityNumber,
            o.customer?.legalName ?? o.prospectName ?? "",
            o.mix?.code ?? "",
            o.estimatedVolumeM3 ?? 0,
            o.status,
            o.owner?.name ?? "",
            o.expectedCloseDate ? new Date(o.expectedCloseDate).toISOString() : "",
            new Date(o.createdAt).toISOString(),
          ])}
        />
        <p className="text-sm text-ink-muted">{m.salesPipelineReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{salesPipelineData.opportunityCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.salesPipelineReport.opportunityCount(salesPipelineData.opportunityCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(salesPipelineData.winRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.salesPipelineReport.winRateLabel}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(salesPipelineData.wonVolumeM3, 1, " m³")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.salesPipelineReport.wonVolume}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{salesPipelineData.openCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.salesPipelineReport.openCount}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.salesPipelineReport.col.number}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.customer}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.mix}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.volume}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.status}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.owner}</th>
                <th className={ui.th}>{m.salesPipelineReport.col.expectedClose}</th>
              </tr>
            </thead>
            <tbody>
              {salesPipelineData.rows.map((o) => (
                <tr key={o.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{o.opportunityNumber}</td>
                  <td className={ui.td}>{o.customer?.legalName ?? o.prospectName ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{o.mix?.code ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(o.estimatedVolumeM3, 1, " m³")}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${o.status === "WON" ? "bg-good-soft text-good" : o.status === "LOST" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.sales.statusLabel[o.status as keyof typeof dict.modules.sales.statusLabel] ?? o.status}
                    </span>
                  </td>
                  <td className={ui.td}>{o.owner?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{o.expectedCloseDate ? dt.date(o.expectedCloseDate) : "—"}</td>
                </tr>
              ))}
              {salesPipelineData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
