// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { AGING_BUCKETS } from "@/lib/aging";
import { getApAgingReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ApAgingTab({ apAgingData, ctx }: {
  apAgingData: NonNullable<Awaited<ReturnType<typeof getApAgingReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="apAging"
          from={rangeFrom}
          to={rangeTo}
          message={`${dict.modules.finance.aging.apTitle} — ${rangeTo}\n${m.apAgingReport.billCount(apAgingData.billCount)}\n${m.apAgingReport.totalOutstanding(apAgingData.totalOutstanding.toFixed(2))}`}
          filenameBase={`ap-aging-${rangeTo}`}
          headers={["Bill", "Supplier", "PO", "Bill date", "Due date", "Bucket", "Amount due"]}
          rows={apAgingData.rows.map((bill) => [
            bill.billNumber,
            bill.supplier.name,
            bill.purchaseOrder?.poNumber ?? "",
            new Date(bill.billDate).toISOString(),
            new Date(bill.dueDate).toISOString(),
            bill.bucket,
            bill.amountDue,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.apAgingReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{apAgingData.totalOutstanding.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.apAgingReport.totalOutstanding(apAgingData.totalOutstanding.toFixed(2))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{apAgingData.billCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.apAgingReport.billCount(apAgingData.billCount)}</div>
          </div>
          {AGING_BUCKETS.map((b) => (
            <div key={b.key} className={ui.card}>
              <div className="font-mono text-xl tabular">{apAgingData.byBucket[b.key].toFixed(0)}</div>
              <div className="mt-1 text-sm text-ink-muted">{dict.modules.finance.aging.bucketLabel[b.key]}</div>
            </div>
          ))}
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.apAgingReport.col.bill}</th>
                <th className={ui.th}>{m.apAgingReport.col.supplier}</th>
                <th className={ui.th}>{m.apAgingReport.col.po}</th>
                <th className={ui.th}>{m.apAgingReport.col.dueDate}</th>
                <th className={ui.th}>{m.apAgingReport.col.bucket}</th>
                <th className={ui.th}>{m.apAgingReport.col.amountDue}</th>
              </tr>
            </thead>
            <tbody>
              {apAgingData.rows.map((bill) => (
                <tr key={bill.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{bill.billNumber}</td>
                  <td className={ui.td}>{bill.supplier.name}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{bill.purchaseOrder?.poNumber ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(bill.dueDate)}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${bill.bucket === "current" ? "bg-surface-alt text-ink-muted" : "bg-critical-soft text-critical"}`}>
                      {dict.modules.finance.aging.bucketLabel[bill.bucket]}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{bill.amountDue.toFixed(2)} {bill.currency}</td>
                </tr>
              ))}
              {apAgingData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
