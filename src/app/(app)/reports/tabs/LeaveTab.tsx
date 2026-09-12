// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getLeaveReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function LeaveTab({ leaveData, ctx }: {
  leaveData: NonNullable<Awaited<ReturnType<typeof getLeaveReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="leave"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.leave} ${rangeFrom} → ${rangeTo}\n${m.leaveReport.requestCount(leaveData.requestCount)}\n${m.leaveReport.totalDaysApproved(leaveData.totalDaysApproved)}`}
          filenameBase={`leave-${rangeFrom}-${rangeTo}`}
          headers={["Number", "Employee", "Type", "Start", "End", "Days", "Status", "Approved by"]}
          rows={leaveData.rows.map((r) => [
            r.requestNumber,
            r.employee.name,
            r.type,
            new Date(r.startDate).toISOString(),
            new Date(r.endDate).toISOString(),
            r.daysCount,
            r.status,
            r.approvedBy?.name ?? "",
          ])}
        />
        <p className="text-sm text-ink-muted">{m.leaveReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{leaveData.requestCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.leaveReport.requestCount(leaveData.requestCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{leaveData.approvedCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.leaveReport.approvedCount(leaveData.approvedCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{leaveData.pendingCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.leaveReport.pendingCount(leaveData.pendingCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{leaveData.totalDaysApproved}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.leaveReport.totalDaysApproved(leaveData.totalDaysApproved)}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.leaveReport.col.employee}</th>
                <th className={ui.th}>{m.leaveReport.col.type}</th>
                <th className={ui.th}>{m.leaveReport.col.start}</th>
                <th className={ui.th}>{m.leaveReport.col.end}</th>
                <th className={ui.th}>{m.leaveReport.col.days}</th>
                <th className={ui.th}>{m.leaveReport.col.status}</th>
              </tr>
            </thead>
            <tbody>
              {leaveData.rows.map((r) => (
                <tr key={r.id}>
                  <td className={ui.td}>{r.employee.name}</td>
                  <td className={ui.td}>{dict.modules.employees.leave.typeLabel[r.type as keyof typeof dict.modules.employees.leave.typeLabel] ?? r.type}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(r.startDate)}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(r.endDate)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.daysCount}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${r.status === "APPROVED" ? "bg-good-soft text-good" : r.status === "REJECTED" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                      {dict.modules.employees.leave.statusLabel[r.status as keyof typeof dict.modules.employees.leave.statusLabel] ?? r.status}
                    </span>
                  </td>
                </tr>
              ))}
              {leaveData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
