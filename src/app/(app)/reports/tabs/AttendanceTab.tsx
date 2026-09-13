// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getAttendanceReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function AttendanceTab({ attendanceData, ctx }: {
  attendanceData: NonNullable<Awaited<ReturnType<typeof getAttendanceReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="attendance"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.attendance} ${rangeFrom} → ${rangeTo}\n${m.attendanceReport.recordCount(attendanceData.recordCount)}\n${attendanceData.attendanceRate === null ? "" : `${m.attendanceReport.attendanceRateLabel}: ${attendanceData.attendanceRate.toFixed(1)}%`}`}
          filenameBase={`attendance-${rangeFrom}-${rangeTo}`}
          headers={["Employee", "Code", "Role", "Date", "Status", "Check-in", "Check-out", "Notes"]}
          rows={attendanceData.rows.map((r) => [
            r.employee.name,
            r.employee.code ?? "",
            r.employee.role,
            new Date(r.date).toISOString(),
            r.status,
            r.checkInAt ? new Date(r.checkInAt).toISOString() : "",
            r.checkOutAt ? new Date(r.checkOutAt).toISOString() : "",
            r.notes ?? "",
          ])}
        />
        <p className="text-sm text-ink-muted">{m.attendanceReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{attendanceData.recordCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.attendanceReport.recordCount(attendanceData.recordCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{fmt(attendanceData.attendanceRate, 1, "%")}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.attendanceReport.attendanceRateLabel}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular text-critical">{attendanceData.absentCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.attendanceReport.absentCount(attendanceData.absentCount)}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.attendanceReport.col.employee}</th>
                <th className={ui.th}>{m.attendanceReport.col.role}</th>
                <th className={ui.th}>{m.attendanceReport.col.date}</th>
                <th className={ui.th}>{m.attendanceReport.col.status}</th>
                <th className={ui.th}>{m.attendanceReport.col.checkIn}</th>
                <th className={ui.th}>{m.attendanceReport.col.checkOut}</th>
              </tr>
            </thead>
            <tbody>
              {attendanceData.rows.map((r) => (
                <tr key={r.id}>
                  <td className={ui.td}>
                    {r.employee.name}
                    {r.employee.code && <div className="text-xs text-ink-muted" dir="ltr">{r.employee.code}</div>}
                  </td>
                  <td className={ui.td}>{r.employee.role}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(r.date)}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${r.status === "PRESENT" ? "bg-good-soft text-good" : r.status === "ABSENT" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.employees.attendance.statusLabel[r.status as keyof typeof dict.modules.employees.attendance.statusLabel] ?? r.status}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{r.checkInAt ? dt.time(r.checkInAt) : "—"}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{r.checkOutAt ? dt.time(r.checkOutAt) : "—"}</td>
                </tr>
              ))}
              {attendanceData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
