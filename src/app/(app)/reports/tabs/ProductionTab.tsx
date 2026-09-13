// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getProductionReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function ProductionTab({ production, ctx }: {
  production: NonNullable<Awaited<ReturnType<typeof getProductionReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="production"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.production} ${rangeFrom} → ${rangeTo}\n${m.production.totalVolume(production.totalVolumeM3.toFixed(1))}\n${m.production.ticketCount(production.ticketCount)} (${m.production.completedCount(production.completedCount)})`}
          filenameBase={`production-${rangeFrom}-${rangeTo}`}
          headers={["Ticket", "Project", "Customer", "Customer code", "Reservation", "Mix", "Grade", "Pour location", "Volume m3", "Status", "Released", "Load time"]}
          rows={production.rows.map((t) => [
            t.ticketNumber,
            t.reservation.project.name,
            t.reservation.project.customer.legalName,
            t.reservation.project.customer.code ?? "",
            t.reservation.reservationNumber,
            t.mix.code,
            t.mix.grade,
            t.reservation.siteLocation ?? "",
            t.volumeM3,
            t.status,
            new Date(t.releasedAt).toISOString(),
            t.batchCompletedAt ? new Date(t.batchCompletedAt).toISOString() : "",
          ])}
        />
        <div className="flex gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{production.totalVolumeM3.toFixed(1)} m³</div>
            <div className="mt-1 text-sm text-ink-muted">{m.production.ticketCount(production.ticketCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{production.completedCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.production.completedCount(production.completedCount)}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.production.col.ticket}</th>
                <th className={ui.th}>{m.production.col.project}</th>
                <th className={ui.th}>{m.production.col.reservation}</th>
                <th className={ui.th}>{m.production.col.mix}</th>
                <th className={ui.th}>{m.production.col.pourLocation}</th>
                <th className={ui.th}>{m.production.col.volume}</th>
                <th className={ui.th}>{m.production.col.status}</th>
                <th className={ui.th}>{m.production.col.released}</th>
                <th className={ui.th}>{m.production.col.loadTime}</th>
              </tr>
            </thead>
            <tbody>
              {production.rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.ticketNumber}</td>
                  <td className={ui.td}>
                    {t.reservation.project.name}
                    <div className="text-xs text-ink-muted">
                      {t.reservation.project.customer.legalName}
                      {t.reservation.project.customer.code ? ` (${t.reservation.project.customer.code})` : ""}
                    </div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.reservation.reservationNumber}</td>
                  <td className={ui.td}>
                    <span className="font-mono text-xs" dir="ltr">{t.mix.code}</span>
                    <div className="text-xs text-ink-muted">{t.mix.grade}</div>
                  </td>
                  <td className={`${ui.td} text-xs`}>{t.reservation.siteLocation ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{t.volumeM3} m³</td>
                  <td className={ui.td}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(t.releasedAt)}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>
                    {t.batchCompletedAt ? dt.dateTime(t.batchCompletedAt) : "—"}
                  </td>
                </tr>
              ))}
              {production.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
