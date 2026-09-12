// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getSparePartsReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function SparePartsTab({ sparePartsData, ctx }: {
  sparePartsData: NonNullable<Awaited<ReturnType<typeof getSparePartsReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="spareParts"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.spareParts} ${rangeFrom} → ${rangeTo}\n${m.sparePartsReport.receiptCount(sparePartsData.receiptCount)}\n${m.sparePartsReport.issuanceCount(sparePartsData.issuanceCount)}`}
          filenameBase={`spare-parts-${rangeFrom}-${rangeTo}`}
          headers={["Date", "Direction", "Part code", "Part name", "Quantity", "Value", "By"]}
          rows={[
            ...sparePartsData.receipts.map((r) => [new Date(r.receivedAt).toISOString(), "IN", r.sparePart.code, r.sparePart.name, r.quantity, r.quantity * r.unitCost, r.receivedBy.name]),
            ...sparePartsData.issuances.map((i) => [new Date(i.issuedAt).toISOString(), "OUT", i.sparePart.code, i.sparePart.name, i.quantity, i.lineTotal, i.issuedBy.name]),
          ]}
        />
        <p className="text-sm text-ink-muted">{m.sparePartsReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{sparePartsData.receiptCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.sparePartsReport.receiptCount(sparePartsData.receiptCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{sparePartsData.issuanceCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.sparePartsReport.issuanceCount(sparePartsData.issuanceCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{sparePartsData.totalReceivedValue.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.sparePartsReport.totalReceivedValue}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{sparePartsData.totalIssuedValue.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.sparePartsReport.totalIssuedValue}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-critical">{sparePartsData.lowStockCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.sparePartsReport.lowStockCount(sparePartsData.lowStockCount)}</div>
          </div>
        </div>
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-base font-semibold">{m.sparePartsReport.balanceTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.sparePartsReport.col.part}</th>
                <th className={ui.th}>{m.sparePartsReport.col.balance}</th>
              </tr>
            </thead>
            <tbody>
              {sparePartsData.balances.map((b) => (
                <tr key={b.key}>
                  <td className={ui.td}>{b.partName} <span className="font-mono text-xs text-ink-muted" dir="ltr">{b.partCode}</span></td>
                  <td className={`${ui.td} font-mono tabular font-semibold ${b.balance <= 0 ? "text-critical" : ""}`}>{b.balance}</td>
                </tr>
              ))}
              {sparePartsData.balances.length === 0 && (
                <tr><td className={ui.td} colSpan={2}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
