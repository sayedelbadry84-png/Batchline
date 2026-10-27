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
import { formatByCurrency } from "@/lib/currencyTotals";

// PM review 2026-10-27 P1-1: one section per currency. Revenue, cost and
// margin are never combined across currencies; per-m³ figures use the
// volume batched at plants billing in that currency.
export function ProfitabilityTab({ profitability, ctx }: {
  profitability: NonNullable<Awaited<ReturnType<typeof getProfitabilityReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  const costRows = (c: (typeof profitability.byCurrency)[number]) => [
    [m.profitability.materialCost, c.materialCost],
    [m.profitability.laborCost, c.laborCost],
    [m.profitability.maintenanceCost, c.maintenanceCost],
    [m.profitability.fuelCost, c.fuelCost],
    [m.profitability.utilitiesCost, c.utilitiesCost],
    [m.profitability.otherCost, c.otherCost],
  ] as const;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="profitability"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.profitability} ${rangeFrom} → ${rangeTo}
${m.profitability.revenue}: ${formatByCurrency(profitability.revenue)}
${m.profitability.totalCost}: ${formatByCurrency(profitability.totalCost)}
${m.profitability.margin}: ${formatByCurrency(profitability.margin)}`}
          filenameBase={`profitability-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Currency", "Metric", "Amount"]}
          rows={profitability.byCurrency.flatMap((c) => [
            [rangeFrom, rangeTo, c.currency, m.profitability.revenue, c.revenue],
            ...costRows(c).map(([label, amount]) => [rangeFrom, rangeTo, c.currency, label, amount]),
            [rangeFrom, rangeTo, c.currency, m.profitability.totalCost, c.totalCost],
            [rangeFrom, rangeTo, c.currency, m.profitability.margin, c.margin],
          ])}
        />

        {profitability.unpricedComponents > 0 && (
          <div className={`${ui.card} border-warn/40`}>
            <p className="text-sm text-warn">{m.profitability.unpricedNote(profitability.unpricedComponents)}</p>
          </div>
        )}
        <p className="text-xs text-ink-muted">{m.profitability.perCurrencyNote}</p>
        {profitability.materialCostCurrencyAssumed && <p className="text-xs text-ink-muted">{m.profitability.materialCurrencyNote}</p>}

        {profitability.byCurrency.length === 0 && <div className={ui.card}><span className="text-ink-muted">{m.noRows}</span></div>}
        {profitability.byCurrency.map((c) => (
          <div key={c.currency} className="flex flex-col gap-4">
            <h2 className="font-display text-base font-semibold" dir="ltr">{c.currency}</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className={ui.card}>
                <div className="text-xs text-ink-muted">{m.profitability.revenue}</div>
                <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{c.revenue.toLocaleString()} {c.currency}</div>
              </div>
              <div className={ui.card}>
                <div className="text-xs text-ink-muted">{m.profitability.totalCost}</div>
                <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{c.totalCost.toLocaleString()} {c.currency}</div>
              </div>
              <div className={ui.card}>
                <div className="text-xs text-ink-muted">{m.profitability.margin}</div>
                <div className={`mt-1 font-mono text-2xl font-semibold ${c.margin >= 0 ? "text-good" : "text-critical"}`} dir="ltr">
                  {c.margin.toLocaleString()} {c.currency}
                </div>
              </div>
              <div className={ui.card}>
                <div className="text-xs text-ink-muted">{m.profitability.marginPct}</div>
                <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{fmt(c.marginPct, 1, "%")}</div>
              </div>
            </div>

            <div className={ui.card}>
              <h3 className="mb-3 font-display text-sm font-semibold">{m.profitability.costBreakdown}</h3>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.profitability.category}</th>
                    <th className={ui.th}>{m.profitability.amount}</th>
                  </tr>
                </thead>
                <tbody>
                  {costRows(c).map(([label, amount]) => (
                    <tr key={label}>
                      <td className={ui.td}>{label}</td>
                      <td className={`${ui.td} font-mono tabular`} dir="ltr">{amount.toLocaleString()} {c.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={ui.card}>
              <h3 className="mb-3 font-display text-sm font-semibold">{m.profitability.perM3}</h3>
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
                    <td className={`${ui.td} font-mono tabular`}>{c.volumeM3.toFixed(1)} m³</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(c.revenuePerM3, 2)}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(c.costPerM3, 2)}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{fmt(c.marginPerM3, 2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
  );
}
