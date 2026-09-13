// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getSupplierPerformanceReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function SupplierPerformanceTab({ supplierPerformanceData, ctx }: {
  supplierPerformanceData: NonNullable<Awaited<ReturnType<typeof getSupplierPerformanceReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="supplierPerformance"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.supplierPerformance} ${rangeFrom} → ${rangeTo}\n${m.supplierPerformanceReport.supplierCount(supplierPerformanceData.supplierCount)}`}
          filenameBase={`supplier-performance-${rangeFrom}-${rangeTo}`}
          headers={["Supplier", "Orders", "Value", "Received", "On-time %", "Lead time (days, on file)", "Rejection rate % (on file)"]}
          rows={supplierPerformanceData.rows.map((s) => [
            s.supplierName,
            s.orderCount,
            s.totalValue,
            s.receivedCount,
            s.onTimeRatePct ?? "",
            s.leadTimeDaysOnFile ?? "",
            s.rejectionRatePct,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.supplierPerformanceReport.intro}</p>
        <div className={ui.card}>
          <div className="font-mono text-2xl tabular">{supplierPerformanceData.supplierCount}</div>
          <div className="mt-1 text-sm text-ink-muted">{m.supplierPerformanceReport.supplierCount(supplierPerformanceData.supplierCount)}</div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.supplierPerformanceReport.col.supplier}</th>
                <th className={ui.th}>{m.supplierPerformanceReport.col.orders}</th>
                <th className={ui.th}>{m.supplierPerformanceReport.col.value}</th>
                <th className={ui.th}>{m.supplierPerformanceReport.col.onTimeRate}</th>
                <th className={ui.th}>{m.supplierPerformanceReport.col.leadTime}</th>
                <th className={ui.th}>{m.supplierPerformanceReport.col.rejectionRate}</th>
              </tr>
            </thead>
            <tbody>
              {supplierPerformanceData.rows.map((s) => (
                <tr key={s.supplierId}>
                  <td className={ui.td}>{s.supplierName}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.orderCount}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.totalValue.toFixed(2)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(s.onTimeRatePct, 0, "%")}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.leadTimeDaysOnFile ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.rejectionRatePct.toFixed(1)}%</td>
                </tr>
              ))}
              {supplierPerformanceData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
