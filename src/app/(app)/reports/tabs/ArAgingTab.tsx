// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { AGING_BUCKETS } from "@/lib/aging";
import { getArAgingReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ArAgingTab({ arAgingData, ctx }: {
  arAgingData: NonNullable<Awaited<ReturnType<typeof getArAgingReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="arAging"
          from={rangeFrom}
          to={rangeTo}
          message={`${dict.modules.finance.aging.arTitle} — ${rangeTo}\n${m.arAgingReport.invoiceCount(arAgingData.invoiceCount)}\n${m.arAgingReport.totalOutstanding(arAgingData.totalOutstanding.toFixed(2))}`}
          filenameBase={`ar-aging-${rangeTo}`}
          headers={["Invoice", "Customer", "Project", "Issue date", "Due date", "Bucket", "Amount due"]}
          rows={arAgingData.rows.map((inv) => [
            inv.invoiceNumber,
            inv.customer.legalName,
            inv.project?.name ?? "",
            new Date(inv.issueDate).toISOString(),
            new Date(inv.dueDate).toISOString(),
            inv.bucket,
            inv.amountDue,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.arAgingReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{arAgingData.totalOutstanding.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.arAgingReport.totalOutstanding(arAgingData.totalOutstanding.toFixed(2))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{arAgingData.invoiceCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.arAgingReport.invoiceCount(arAgingData.invoiceCount)}</div>
          </div>
          {AGING_BUCKETS.map((b) => (
            <div key={b.key} className={ui.card}>
              <div className="font-mono text-xl tabular">{arAgingData.byBucket[b.key].toFixed(0)}</div>
              <div className="mt-1 text-sm text-ink-muted">{dict.modules.finance.aging.bucketLabel[b.key]}</div>
            </div>
          ))}
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.arAgingReport.col.invoice}</th>
                <th className={ui.th}>{m.arAgingReport.col.customer}</th>
                <th className={ui.th}>{m.arAgingReport.col.project}</th>
                <th className={ui.th}>{m.arAgingReport.col.dueDate}</th>
                <th className={ui.th}>{m.arAgingReport.col.bucket}</th>
                <th className={ui.th}>{m.arAgingReport.col.amountDue}</th>
              </tr>
            </thead>
            <tbody>
              {arAgingData.rows.map((inv) => (
                <tr key={inv.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{inv.invoiceNumber}</td>
                  <td className={ui.td}>{inv.customer.legalName}</td>
                  <td className={ui.td}>{inv.project?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(inv.dueDate)}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${inv.bucket === "current" ? "bg-surface-alt text-ink-muted" : "bg-critical-soft text-critical"}`}>
                      {dict.modules.finance.aging.bucketLabel[inv.bucket]}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{inv.amountDue.toFixed(2)} {inv.currency}</td>
                </tr>
              ))}
              {arAgingData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
