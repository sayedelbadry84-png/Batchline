// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getFinishedGoodsReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function FinishedGoodsTab({ finishedGoodsData, ctx }: {
  finishedGoodsData: NonNullable<Awaited<ReturnType<typeof getFinishedGoodsReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="finishedGoods"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.finishedGoods} ${rangeFrom} → ${rangeTo}\n${m.finishedGoodsReport.movementCount(finishedGoodsData.movementCount)}`}
          filenameBase={`finished-goods-${rangeFrom}-${rangeTo}`}
          headers={["Date", "Direction", "Product code", "Product name", "Quantity", "Site", "By", "Notes"]}
          rows={finishedGoodsData.rows.map((mv) => [
            new Date(mv.occurredAt).toISOString(),
            mv.direction,
            mv.product.code,
            mv.product.name,
            mv.quantity,
            mv.site.name,
            mv.recordedBy.name,
            mv.notes ?? "",
          ])}
        />
        <p className="text-sm text-ink-muted">{m.finishedGoodsReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{finishedGoodsData.movementCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.finishedGoodsReport.movementCount(finishedGoodsData.movementCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-good">{finishedGoodsData.producedQty}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.finishedGoodsReport.producedQty}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{finishedGoodsData.shippedQty}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.finishedGoodsReport.shippedQty}</div>
          </div>
        </div>
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-base font-semibold">{m.finishedGoodsReport.balanceTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.finishedGoodsReport.col.product}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.balance}</th>
              </tr>
            </thead>
            <tbody>
              {finishedGoodsData.balances.map((b) => (
                <tr key={b.key}>
                  <td className={ui.td}>{b.productName} <span className="font-mono text-xs text-ink-muted" dir="ltr">{b.productCode}</span></td>
                  <td className={`${ui.td} font-mono tabular font-semibold ${b.balance <= 0 ? "text-critical" : ""}`}>{b.balance}</td>
                </tr>
              ))}
              {finishedGoodsData.balances.length === 0 && (
                <tr><td className={ui.td} colSpan={2}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.finishedGoodsReport.col.date}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.direction}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.product}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.quantity}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.site}</th>
                <th className={ui.th}>{m.finishedGoodsReport.col.by}</th>
              </tr>
            </thead>
            <tbody>
              {finishedGoodsData.rows.map((mv) => (
                <tr key={mv.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(mv.occurredAt)}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${mv.direction === "IN" ? "bg-good-soft text-good" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.warehouses.finishedGoods.directionLabel[mv.direction as keyof typeof dict.modules.warehouses.finishedGoods.directionLabel] ?? mv.direction}
                    </span>
                  </td>
                  <td className={ui.td}>{mv.product.name} <span className="font-mono text-xs text-ink-muted" dir="ltr">{mv.product.code}</span></td>
                  <td className={`${ui.td} font-mono tabular`}>{mv.quantity}</td>
                  <td className={ui.td}>{mv.site.name}</td>
                  <td className={ui.td}>{mv.recordedBy.name}</td>
                </tr>
              ))}
              {finishedGoodsData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
