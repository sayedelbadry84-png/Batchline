// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getCashLedgerReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function CashLedgerTab({ cashLedgerData, ctx }: {
  cashLedgerData: NonNullable<Awaited<ReturnType<typeof getCashLedgerReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="cashLedger"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.cashLedger} ${rangeFrom} → ${rangeTo}\n${m.cashLedgerReport.totalIn(cashLedgerData.totalIn.toFixed(2))}\n${m.cashLedgerReport.totalOut(cashLedgerData.totalOut.toFixed(2))}\n${m.cashLedgerReport.net(cashLedgerData.net.toFixed(2))}`}
          filenameBase={`cash-ledger-${rangeFrom}-${rangeTo}`}
          headers={["Date", "Number", "Direction", "Category", "Description", "Amount", "Currency", "By", "Reconciled"]}
          rows={cashLedgerData.rows.map((t) => [
            new Date(t.occurredAt).toISOString(),
            t.txnNumber,
            t.direction,
            t.category,
            t.description,
            t.amount,
            t.currency,
            t.createdBy.name,
            t.reconciled ? "Yes" : "No",
          ])}
        />
        <p className="text-sm text-ink-muted">{m.cashLedgerReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-good">{cashLedgerData.totalIn.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.cashLedgerReport.totalIn(cashLedgerData.totalIn.toFixed(2))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-critical">{cashLedgerData.totalOut.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.cashLedgerReport.totalOut(cashLedgerData.totalOut.toFixed(2))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{cashLedgerData.net.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.cashLedgerReport.net(cashLedgerData.net.toFixed(2))}</div>
          </div>
        </div>
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-base font-semibold">{m.cashLedgerReport.byCategoryTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.cashLedgerReport.col.category}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.in}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.out}</th>
              </tr>
            </thead>
            <tbody>
              {cashLedgerData.byCategory.map((c) => (
                <tr key={c.category}>
                  <td className={ui.td}>{dict.modules.finance.cash.categoryLabel[c.category as keyof typeof dict.modules.finance.cash.categoryLabel] ?? c.category}</td>
                  <td className={`${ui.td} font-mono tabular text-good`}>{c.in.toFixed(2)}</td>
                  <td className={`${ui.td} font-mono tabular text-critical`}>{c.out.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.cashLedgerReport.col.date}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.number}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.direction}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.category}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.description}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.amount}</th>
                <th className={ui.th}>{m.cashLedgerReport.col.by}</th>
              </tr>
            </thead>
            <tbody>
              {cashLedgerData.rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(t.occurredAt)}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.txnNumber}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${t.direction === "IN" ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}>
                      {t.direction === "IN" ? dict.modules.finance.cash.in : dict.modules.finance.cash.out}
                    </span>
                  </td>
                  <td className={ui.td}>{dict.modules.finance.cash.categoryLabel[t.category as keyof typeof dict.modules.finance.cash.categoryLabel] ?? t.category}</td>
                  <td className={ui.td}>{t.description}</td>
                  <td className={`${ui.td} font-mono tabular`}>{t.amount.toFixed(2)} {t.currency}</td>
                  <td className={ui.td}>{t.createdBy.name}</td>
                </tr>
              ))}
              {cashLedgerData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
