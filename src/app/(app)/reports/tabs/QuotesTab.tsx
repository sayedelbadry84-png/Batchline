// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getQuotesReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function QuotesTab({ quotesData, ctx }: {
  quotesData: NonNullable<Awaited<ReturnType<typeof getQuotesReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="quotes"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.quotes} ${rangeFrom} → ${rangeTo}\n${m.quotesReport.quoteCount(quotesData.quoteCount)}\n${quotesData.conversionRate === null ? "" : `${m.quotesReport.conversionRateLabel}: ${quotesData.conversionRate.toFixed(1)}%`}`}
          filenameBase={`quotes-${rangeFrom}-${rangeTo}`}
          headers={["Number", "Customer", "Prepared by", "Status", "Total", "Currency", "Valid until", "Sent"]}
          rows={quotesData.rows.map((q) => [
            q.quoteNumber,
            q.customer.legalName,
            q.preparedBy.name,
            q.status,
            q.total,
            q.currency,
            q.validUntil ? new Date(q.validUntil).toISOString() : "",
            q.sentAt ? new Date(q.sentAt).toISOString() : "",
          ])}
        />
        <p className="text-sm text-ink-muted">{m.quotesReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{quotesData.quoteCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.quotesReport.quoteCount(quotesData.quoteCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(quotesData.conversionRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.quotesReport.conversionRateLabel}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{quotesData.totalValue.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.quotesReport.totalValue}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{quotesData.acceptedValue.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.quotesReport.acceptedValue}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.quotesReport.col.number}</th>
                <th className={ui.th}>{m.quotesReport.col.customer}</th>
                <th className={ui.th}>{m.quotesReport.col.preparedBy}</th>
                <th className={ui.th}>{m.quotesReport.col.status}</th>
                <th className={ui.th}>{m.quotesReport.col.total}</th>
                <th className={ui.th}>{m.quotesReport.col.validUntil}</th>
              </tr>
            </thead>
            <tbody>
              {quotesData.rows.map((q) => (
                <tr key={q.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{q.quoteNumber}</td>
                  <td className={ui.td}>{q.customer.legalName}</td>
                  <td className={ui.td}>{q.preparedBy.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${q.status === "ACCEPTED" ? "bg-good-soft text-good" : q.status === "DECLINED" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.sales.quotes.statusLabel[q.status as keyof typeof dict.modules.sales.quotes.statusLabel] ?? q.status}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{q.total.toFixed(2)} {q.currency}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{q.validUntil ? dt.date(q.validUntil) : "—"}</td>
                </tr>
              ))}
              {quotesData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
