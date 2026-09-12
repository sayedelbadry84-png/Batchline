// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getConsumptionReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ConsumptionTab({ consumption, ctx }: {
  consumption: NonNullable<Awaited<ReturnType<typeof getConsumptionReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="consumption"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.consumption} ${rangeFrom} → ${rangeTo}\n${m.consumption.ticketCount(consumption.ticketCount)}\n${consumption.rows.map((r) => `${r.materialName}: ${(r.massKg / 1000).toFixed(2)} t`).join("\n")}`}
          filenameBase={`consumption-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Material", "Type", "Mass kg", "Tickets"]}
          rows={consumption.rows.map((r) => [rangeFrom, rangeTo, r.materialName, r.type, r.massKg, r.ticketCount])}
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
  );
}
