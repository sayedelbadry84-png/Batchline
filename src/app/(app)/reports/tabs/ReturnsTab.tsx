// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { MarkDrumReturnFateForm } from "@/components/MarkDrumReturnFateForm";
import { getReturnsReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ReturnsTab({ returnsData, ctx }: {
  returnsData: NonNullable<Awaited<ReturnType<typeof getReturnsReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <div className={`${ui.card} border-warn/40`}>
          <h2 className="mb-1 font-display text-base font-semibold">{m.returnsReport.pendingTitle}</h2>
          <p className="mb-3 text-sm text-ink-muted">{m.returnsReport.pendingIntro}</p>
          {returnsData.pendingFate.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-border py-2 first:border-t-0 first:pt-0">
              <span className="w-24 shrink-0 font-mono text-xs" dir="ltr">{r.trip.truck.code}</span>
              <span className="flex-1 text-sm text-ink-muted">{r.trip.driver.name} · {r.returnedVolumeM3} m³</span>
              <MarkDrumReturnFateForm
                drumReturnId={r.id}
                className="flex flex-wrap items-center gap-2"
                reclaimedButtonClassName="rounded-md border border-good bg-good-soft px-2 py-1 text-xs text-good hover:opacity-80"
                dumpedButtonClassName="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt"
                messages={{ reclaimedLabel: dict.returnFates.RECLAIMED, dumpedLabel: dict.returnFates.DUMPED, errors: dict.modules.trips.errors }}
              />
            </div>
          ))}
          {returnsData.pendingFate.length === 0 && <p className="text-sm text-ink-muted">{m.returnsReport.pendingEmpty}</p>}
        </div>

        <ExportBar
          m={m}
          tab="returns"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.returns} ${rangeFrom} → ${rangeTo}\n${m.returnsReport.totalReturned(returnsData.totalReturnedM3.toFixed(1))}\n${m.returnsReport.wasted(returnsData.wastedM3.toFixed(1))}`}
          filenameBase={`returns-${rangeFrom}-${rangeTo}`}
          headers={["Discharged", "Truck", "Driver", "Project", "Customer", "Customer code", "Ticket", "Reservation", "Mix", "Grade", "Pour location", "Returned m3", "Disposition", "Reason", "Quality approval", "Quality finding"]}
          rows={returnsData.rows.map((r) => [
            r.trip.dischargeEnd ? new Date(r.trip.dischargeEnd).toISOString() : "",
            r.trip.truck.code,
            r.trip.driver.name,
            r.trip.batchTicket.reservation.project.name,
            r.trip.batchTicket.reservation.project.customer.legalName,
            r.trip.batchTicket.reservation.project.customer.code ?? "",
            r.trip.batchTicket.ticketNumber,
            r.trip.batchTicket.reservation.reservationNumber,
            r.trip.batchTicket.mix.code,
            r.trip.batchTicket.mix.grade,
            r.trip.batchTicket.reservation.siteLocation ?? "",
            r.returnedVolumeM3,
            r.disposition,
            r.reasonCode ?? "",
            r.reasonCode === "QUALITY_REJECTED" ? (r.wasteMemo?.status === "APPROVED" ? "APPROVED" : "PENDING") : "",
            r.wasteMemo?.approvalNote ?? "",
          ])}
        />
        <div className="flex gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-good">{returnsData.reclaimedM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.reclaimed(returnsData.reclaimedM3.toFixed(1))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{returnsData.totalReturnedM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.returnCount(returnsData.returnCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-critical">{returnsData.wastedM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.wasted(returnsData.wastedM3.toFixed(1))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-good">{returnsData.reclaimedAndReusedM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.returnsReport.reclaimedAndReused}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.returnsReport.col.discharged}</th>
                <th className={ui.th}>{m.returnsReport.col.truck}</th>
                <th className={ui.th}>{m.returnsReport.col.driver}</th>
                <th className={ui.th}>{m.returnsReport.col.project}</th>
                <th className={ui.th}>{m.returnsReport.col.ticket}</th>
                <th className={ui.th}>{m.returnsReport.col.reservation}</th>
                <th className={ui.th}>{m.returnsReport.col.mix}</th>
                <th className={ui.th}>{m.returnsReport.col.pourLocation}</th>
                <th className={ui.th}>{m.returnsReport.col.returned}</th>
                <th className={ui.th}>{m.returnsReport.col.disposition}</th>
                <th className={ui.th}>{m.returnsReport.col.reason}</th>
                <th className={ui.th}>{m.returnsReport.col.qualityApproval}</th>
              </tr>
            </thead>
            <tbody>
              {returnsData.rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{r.trip.dischargeEnd ? dt.date(r.trip.dischargeEnd) : "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.truck.code}</td>
                  <td className={ui.td}>{r.trip.driver.name}</td>
                  <td className={ui.td}>
                    {r.trip.batchTicket.reservation.project.name}
                    <div className="text-xs text-ink-muted">
                      {r.trip.batchTicket.reservation.project.customer.legalName}
                      {r.trip.batchTicket.reservation.project.customer.code ? ` (${r.trip.batchTicket.reservation.project.customer.code})` : ""}
                    </div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.batchTicket.ticketNumber}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.trip.batchTicket.reservation.reservationNumber}</td>
                  <td className={ui.td}>
                    <span className="font-mono text-xs" dir="ltr">{r.trip.batchTicket.mix.code}</span>
                    <div className="text-xs text-ink-muted">{r.trip.batchTicket.mix.grade}</div>
                  </td>
                  <td className={`${ui.td} text-xs`}>{r.trip.batchTicket.reservation.siteLocation ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.returnedVolumeM3} m³</td>
                  <td className={ui.td}>{dict.status[r.disposition as keyof typeof dict.status] ?? r.disposition}</td>
                  <td className={ui.td}>{r.reasonCode ? (dict.returnReasons[r.reasonCode as keyof typeof dict.returnReasons] ?? r.reasonCode) : "—"}</td>
                  <td className={ui.td}>
                    {r.reasonCode === "QUALITY_REJECTED" ? (
                      <>
                        <span className={`${ui.chip} ${r.wasteMemo?.status === "APPROVED" ? "bg-good-soft text-good" : "bg-warn-soft text-warn"}`}>
                          {r.wasteMemo?.status === "APPROVED" && r.wasteMemo.approvedBy
                            ? dict.modules.production.detail.wasteMemoApproved(r.wasteMemo.approvedBy.name, dt.date(r.wasteMemo.approvedAt!))
                            : dict.modules.production.detail.wasteMemoPending}
                        </span>
                        {r.wasteMemo?.approvalNote && (
                          <div className="mt-1 max-w-xs text-xs text-ink-muted">{r.wasteMemo.approvalNote}</div>
                        )}
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {returnsData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={13}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
