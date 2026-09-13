// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getPurchaseOrdersReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function PurchaseOrdersTab({ purchaseOrdersData, ctx }: {
  purchaseOrdersData: NonNullable<Awaited<ReturnType<typeof getPurchaseOrdersReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="purchaseOrders"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.purchaseOrders} ${rangeFrom} → ${rangeTo}\n${m.purchaseOrdersReport.orderCount(purchaseOrdersData.orderCount)}\n${m.purchaseOrdersReport.totalValue}: ${purchaseOrdersData.totalValue.toFixed(2)}`}
          filenameBase={`purchase-orders-${rangeFrom}-${rangeTo}`}
          headers={["Number", "Supplier", "Status", "Total", "Currency", "Order date", "Expected date", "Created by"]}
          rows={purchaseOrdersData.rows.map((o) => [
            o.poNumber,
            o.supplier.name,
            o.status,
            o.total,
            o.currency,
            new Date(o.orderDate).toISOString(),
            o.expectedDate ? new Date(o.expectedDate).toISOString() : "",
            o.createdBy.name,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.purchaseOrdersReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{purchaseOrdersData.orderCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.purchaseOrdersReport.orderCount(purchaseOrdersData.orderCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{purchaseOrdersData.totalValue.toFixed(2)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.purchaseOrdersReport.totalValue}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{purchaseOrdersData.openCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.purchaseOrdersReport.openCount}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-critical">{purchaseOrdersData.overdueCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.purchaseOrdersReport.overdueCount}</div>
          </div>
        </div>
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-base font-semibold">{m.purchaseOrdersReport.bySupplierTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.purchaseOrdersReport.col.supplier}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.number}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.total}</th>
              </tr>
            </thead>
            <tbody>
              {purchaseOrdersData.bySupplier.map((s) => (
                <tr key={s.supplierName}>
                  <td className={ui.td}>{s.supplierName}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.orderCount}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.value.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.purchaseOrdersReport.col.number}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.supplier}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.status}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.total}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.orderDate}</th>
                <th className={ui.th}>{m.purchaseOrdersReport.col.expectedDate}</th>
              </tr>
            </thead>
            <tbody>
              {purchaseOrdersData.rows.map((o) => (
                <tr key={o.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{o.poNumber}</td>
                  <td className={ui.td}>{o.supplier.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${o.status === "RECEIVED" ? "bg-good-soft text-good" : o.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.purchasing.orders.statusLabel[o.status as keyof typeof dict.modules.purchasing.orders.statusLabel] ?? o.status}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{o.total.toFixed(2)} {o.currency}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(o.orderDate)}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{o.expectedDate ? dt.date(o.expectedDate) : "—"}</td>
                </tr>
              ))}
              {purchaseOrdersData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
