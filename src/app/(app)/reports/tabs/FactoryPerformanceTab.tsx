// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getFactoryPerformanceReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function FactoryPerformanceTab({ factoryPerformanceData, ctx }: {
  factoryPerformanceData: NonNullable<Awaited<ReturnType<typeof getFactoryPerformanceReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="factoryPerformance"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.factoryPerformance} ${rangeFrom} → ${rangeTo}`}
          filenameBase={`factory-performance-${rangeFrom}-${rangeTo}`}
          headers={["Quarter", "Production cost", "Concrete volume (m³)", "Finished goods shipped", "Returns (m³)", "Customers", "Workers"]}
          rows={factoryPerformanceData.rows.map((r) => [
            r.label,
            r.productionCost,
            r.concreteVolumeM3,
            r.finishedGoodsShippedQty,
            r.returnedVolumeM3,
            r.customerCount,
            r.workerCount,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.factoryPerformanceReport.intro}</p>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.factoryPerformanceReport.col.quarter}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.productionCost}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.concreteVolume}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.finishedGoodsShipped}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.returns}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.customers}</th>
                <th className={ui.th}>{m.factoryPerformanceReport.col.workers}</th>
              </tr>
            </thead>
            <tbody>
              {factoryPerformanceData.rows.map((r) => (
                <tr key={r.label}>
                  <td className={`${ui.td} font-medium`}>{r.label}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.productionCost.toFixed(2)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.concreteVolumeM3.toFixed(1)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.finishedGoodsShippedQty}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.returnedVolumeM3.toFixed(1)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.customerCount}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.workerCount}</td>
                </tr>
              ))}
              {factoryPerformanceData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
