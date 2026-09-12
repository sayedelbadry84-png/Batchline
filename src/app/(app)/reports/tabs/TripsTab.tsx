// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getTripsReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function TripsTab({ tripsData, ctx }: {
  tripsData: NonNullable<Awaited<ReturnType<typeof getTripsReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="trips"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.trips} ${rangeFrom} → ${rangeTo}\n${m.tripsReport.totalDelivered(tripsData.totalDeliveredM3.toFixed(1))}\n${m.tripsReport.tripCount(tripsData.tripCount)}`}
          filenameBase={`trips-${rangeFrom}-${rangeTo}`}
          headers={["Discharged", "Truck", "Driver", "Project", "Customer", "Customer code", "Ticket", "Reservation", "Mix", "Grade", "Pour location", "Load time", "Delivered m3"]}
          rows={tripsData.rows.map((t) => [
            t.dischargeEnd ? new Date(t.dischargeEnd).toISOString() : "",
            t.truck.code,
            t.driver.name,
            t.batchTicket.reservation.project.name,
            t.batchTicket.reservation.project.customer.legalName,
            t.batchTicket.reservation.project.customer.code ?? "",
            t.batchTicket.ticketNumber,
            t.batchTicket.reservation.reservationNumber,
            t.batchTicket.mix.code,
            t.batchTicket.mix.grade,
            t.batchTicket.reservation.siteLocation ?? "",
            t.batchTicket.batchCompletedAt ? new Date(t.batchTicket.batchCompletedAt).toISOString() : "",
            t.volumeDeliveredM3 ?? 0,
          ])}
        />
        <div className="flex gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{tripsData.totalDeliveredM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.tripsReport.tripCount(tripsData.tripCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(tripsData.avgCycleTimeMin, 0)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.tripsReport.avgCycleTime(fmt(tripsData.avgCycleTimeMin, 0))}</div>
          </div>
        </div>

        <div>
          <h2 className="mb-1 font-display text-lg font-semibold">{m.tripsReport.byProjectTitle}</h2>
          <p className="mb-3 text-sm text-ink-muted">{m.tripsReport.byProjectIntro}</p>
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.customer}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.project}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.trips}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.transit}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.wait}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.pour}</th>
                  <th className={ui.th}>{m.tripsReport.byProjectCol.cycle}</th>
                </tr>
              </thead>
              <tbody>
                {tripsData.byProject.map((r, i) => (
                  <tr key={i}>
                    <td className={ui.td}>
                      {r.customerName}
                      {r.customerCode && <span className="ms-1 font-mono text-xs text-ink-muted">({r.customerCode})</span>}
                    </td>
                    <td className={ui.td}>{r.projectName}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.tripCount}</td>
                    <td className={`${ui.td} font-mono tabular`}>{fmt(r.avgTransitMin, 0, " min")}</td>
                    <td className={`${ui.td} font-mono tabular`}>{fmt(r.avgWaitMin, 0, " min")}</td>
                    <td className={`${ui.td} font-mono tabular`}>{fmt(r.avgPourMin, 0, " min")}</td>
                    <td className={`${ui.td} font-mono tabular font-medium`}>{fmt(r.avgCycleTimeMin, 0, " min")}</td>
                  </tr>
                ))}
                {tripsData.byProject.length === 0 && (
                  <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.tripsReport.col.closed}</th>
                <th className={ui.th}>{m.tripsReport.col.truck}</th>
                <th className={ui.th}>{m.tripsReport.col.driver}</th>
                <th className={ui.th}>{m.tripsReport.col.project}</th>
                <th className={ui.th}>{m.tripsReport.col.ticket}</th>
                <th className={ui.th}>{m.tripsReport.col.reservation}</th>
                <th className={ui.th}>{m.tripsReport.col.mix}</th>
                <th className={ui.th}>{m.tripsReport.col.pourLocation}</th>
                <th className={ui.th}>{m.tripsReport.col.loadTime}</th>
                <th className={ui.th}>{m.tripsReport.col.delivered}</th>
              </tr>
            </thead>
            <tbody>
              {tripsData.rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{t.dischargeEnd ? dt.dateTime(t.dischargeEnd) : "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.truck.code}</td>
                  <td className={ui.td}>{t.driver.name}</td>
                  <td className={ui.td}>
                    {t.batchTicket.reservation.project.name}
                    <div className="text-xs text-ink-muted">
                      {t.batchTicket.reservation.project.customer.legalName}
                      {t.batchTicket.reservation.project.customer.code ? ` (${t.batchTicket.reservation.project.customer.code})` : ""}
                    </div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.ticketNumber}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.reservation.reservationNumber}</td>
                  <td className={ui.td}>
                    <span className="font-mono text-xs" dir="ltr">{t.batchTicket.mix.code}</span>
                    <div className="text-xs text-ink-muted">{t.batchTicket.mix.grade}</div>
                  </td>
                  <td className={`${ui.td} text-xs`}>{t.batchTicket.reservation.siteLocation ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>
                    {t.batchTicket.batchCompletedAt ? dt.dateTime(t.batchTicket.batchCompletedAt) : "—"}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(t.volumeDeliveredM3, 1, " m³")}</td>
                </tr>
              ))}
              {tripsData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={10}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
