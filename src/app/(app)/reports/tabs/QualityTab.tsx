// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getQualityReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function QualityTab({ qualityData, ctx }: {
  qualityData: NonNullable<Awaited<ReturnType<typeof getQualityReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="quality"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.quality} ${rangeFrom} → ${rangeTo}\n${m.qualityReport.resultCount(qualityData.resultCount)}\n${qualityData.passRate === null ? "" : m.qualityReport.passRate(qualityData.passRate.toFixed(1))}`}
          filenameBase={`quality-${rangeFrom}-${rangeTo}`}
          headers={["Tested on", "Ticket", "Project", "Customer", "Mix", "Age days", "Measured MPa", "Target MPa", "Margin %", "Result"]}
          rows={qualityData.rows.map((r) => {
            const ticket = r.testBatch.trip.batchTicket;
            return [
              new Date(r.testedOn).toISOString(),
              ticket.ticketNumber,
              ticket.reservation.project.name,
              ticket.reservation.project.customer.legalName,
              ticket.mix.code,
              r.ageDays,
              r.breakStrengthMpa,
              r.targetStrengthMpa,
              ((r.breakStrengthMpa - r.targetStrengthMpa) / r.targetStrengthMpa) * 100,
              r.passFail,
            ];
          })}
        />
        <p className="text-sm text-ink-muted">{m.qualityReport.intro}</p>
        <div className="flex gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(qualityData.passRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.qualityReport.finalOnlyNote(qualityData.finalResultCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{qualityData.resultCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.qualityReport.resultCount(qualityData.resultCount)}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.qualityReport.col.testedOn}</th>
                <th className={ui.th}>{m.qualityReport.col.ticket}</th>
                <th className={ui.th}>{m.qualityReport.col.project}</th>
                <th className={ui.th}>{m.qualityReport.col.mix}</th>
                <th className={ui.th}>{m.qualityReport.col.age}</th>
                <th className={ui.th}>{m.qualityReport.col.strength}</th>
                <th className={ui.th}>{m.qualityReport.col.target}</th>
                <th className={ui.th}>{m.qualityReport.col.margin}</th>
                <th className={ui.th}>{m.qualityReport.col.result}</th>
              </tr>
            </thead>
            <tbody>
              {qualityData.rows.map((r) => {
                const ticket = r.testBatch.trip.batchTicket;
                const marginPct = ((r.breakStrengthMpa - r.targetStrengthMpa) / r.targetStrengthMpa) * 100;
                return (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(r.testedOn)}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{ticket.ticketNumber}</td>
                    <td className={ui.td}>
                      {ticket.reservation.project.name}
                      <div className="text-xs text-ink-muted">{ticket.reservation.project.customer.legalName}</div>
                    </td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{ticket.mix.code}</span>
                      <div className="text-xs text-ink-muted">{ticket.mix.grade}</div>
                    </td>
                    <td className={`${ui.td} font-mono tabular`}>{r.ageDays}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.breakStrengthMpa.toFixed(1)}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.targetStrengthMpa.toFixed(1)}</td>
                    <td className={`${ui.td} font-mono tabular ${marginPct < 0 ? "text-critical" : "text-good"}`}>
                      {marginPct > 0 ? "+" : ""}{marginPct.toFixed(1)}%
                    </td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${r.passFail === "PASS" ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}>
                        {dict.status[r.passFail as keyof typeof dict.status] ?? r.passFail}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {qualityData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
