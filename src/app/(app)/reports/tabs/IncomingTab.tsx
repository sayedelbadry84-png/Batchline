// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getIncomingReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function IncomingTab({ incoming, ctx }: {
  incoming: NonNullable<Awaited<ReturnType<typeof getIncomingReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="incoming"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.incoming} ${rangeFrom} → ${rangeTo}\n${m.incoming.totalNetWeight(incoming.totalNetKg.toFixed(0))}\n${m.incoming.receiptCount(incoming.receiptCount)}`}
          filenameBase={`incoming-${rangeFrom}-${rangeTo}`}
          headers={["Received", "Supplier", "Material", "Net weight kg", "PO", "QC status", "Driver"]}
          rows={incoming.rows.map((r) => [new Date(r.receivedAt).toISOString(), r.supplier.name, r.material.name, r.netWeightKg, r.poNumber ?? "", r.qcStatus, r.driver?.name ?? r.driverName ?? ""])}
        />
        <div className={ui.card}>
          <div className="font-mono text-2xl tabular">{incoming.totalNetKg.toFixed(0)} kg</div>
          <div className="mt-1 text-sm text-ink-muted">{m.incoming.receiptCount(incoming.receiptCount)}</div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.incoming.col.received}</th>
                <th className={ui.th}>{m.incoming.col.supplier}</th>
                <th className={ui.th}>{m.incoming.col.material}</th>
                <th className={ui.th}>{m.incoming.col.netWeight}</th>
                <th className={ui.th}>{m.incoming.col.po}</th>
                <th className={ui.th}>{m.incoming.col.qcStatus}</th>
                <th className={ui.th}>{m.incoming.col.driver}</th>
              </tr>
            </thead>
            <tbody>
              {incoming.rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(r.receivedAt)}</td>
                  <td className={ui.td}>{r.supplier.name}</td>
                  <td className={ui.td}>{r.material.name}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.netWeightKg.toFixed(0)} kg</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.poNumber || "—"}</td>
                  <td className={ui.td}>{dict.status[r.qcStatus as keyof typeof dict.status] ?? r.qcStatus}</td>
                  <td className={ui.td}>{r.driver?.name ?? r.driverName ?? "—"}</td>
                </tr>
              ))}
              {incoming.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
