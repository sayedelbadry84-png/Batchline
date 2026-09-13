// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getProfitabilityReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ProfitabilityTab({ profitability, ctx }: {
  profitability: NonNullable<Awaited<ReturnType<typeof getProfitabilityReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="profitability"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.profitability} ${rangeFrom} → ${rangeTo}\n${m.profitability.revenue}: ${profitability.revenue.toLocaleString()}\n${m.profitability.totalCost}: ${profitability.totalCost.toLocaleString()}\n${m.profitability.margin}: ${profitability.margin.toLocaleString()}`}
          filenameBase={`profitability-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Metric", "Amount"]}
          rows={[
            [rangeFrom, rangeTo, m.profitability.revenue, profitability.revenue],
            [rangeFrom, rangeTo, m.profitability.materialCost, profitability.materialCost],
            [rangeFrom, rangeTo, m.profitability.laborCost, profitability.laborCost],
            [rangeFrom, rangeTo, m.profitability.maintenanceCost, profitability.maintenanceCost],
            [rangeFrom, rangeTo, m.profitability.fuelCost, profitability.fuelCost],
            [rangeFrom, rangeTo, m.profitability.utilitiesCost, profitability.utilitiesCost],
            [rangeFrom, rangeTo, m.profitability.otherCost, profitability.otherCost],
            [rangeFrom, rangeTo, m.profitability.totalCost, profitability.totalCost],
            [rangeFrom, rangeTo, m.profitability.margin, profitability.margin],
          ]}
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
  );
}
