// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, fmt, type ReportTabContext } from "../reportUi";
import { getMaintenanceReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function MaintenanceTab({ maintenanceData, ctx }: {
  maintenanceData: NonNullable<Awaited<ReturnType<typeof getMaintenanceReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, dt, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="maintenance"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.maintenance} ${rangeFrom} → ${rangeTo}\n${m.maintenanceReport.ticketCount(maintenanceData.ticketCount)}\n${m.maintenanceReport.totalCost(maintenanceData.totalCost.toFixed(0))}`}
          filenameBase={`maintenance-${rangeFrom}-${rangeTo}`}
          headers={["Ticket", "Equipment", "Type", "Priority", "Status", "Reported", "Completed", "Assigned to", "Downtime hours", "Labor cost", "Parts cost"]}
          rows={maintenanceData.rows.map((t) => [
            t.ticketNumber,
            t.equipmentLabel,
            t.type,
            t.priority,
            t.status,
            new Date(t.createdAt).toISOString(),
            t.completedAt ? new Date(t.completedAt).toISOString() : "",
            t.assignedTo?.name ?? "",
            t.downtimeHours ?? 0,
            t.laborCost ?? 0,
            t.partsCost ?? 0,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.maintenanceReport.intro}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{maintenanceData.ticketCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.maintenanceReport.ticketCount(maintenanceData.ticketCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{maintenanceData.openCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.maintenanceReport.openCount(maintenanceData.openCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{maintenanceData.totalDowntimeHours.toFixed(1)}h</div>
            <div className="mt-1 text-sm text-ink-muted">{m.maintenanceReport.totalDowntime(maintenanceData.totalDowntimeHours.toFixed(1))}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{maintenanceData.totalCost.toFixed(0)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.maintenanceReport.totalCost(maintenanceData.totalCost.toFixed(0))}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.maintenanceReport.col.ticket}</th>
                <th className={ui.th}>{m.maintenanceReport.col.equipment}</th>
                <th className={ui.th}>{m.maintenanceReport.col.type}</th>
                <th className={ui.th}>{m.maintenanceReport.col.priority}</th>
                <th className={ui.th}>{m.maintenanceReport.col.status}</th>
                <th className={ui.th}>{m.maintenanceReport.col.reported}</th>
                <th className={ui.th}>{m.maintenanceReport.col.assignedTo}</th>
                <th className={ui.th}>{m.maintenanceReport.col.downtime}</th>
                <th className={ui.th}>{m.maintenanceReport.col.cost}</th>
              </tr>
            </thead>
            <tbody>
              {maintenanceData.rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.ticketNumber}</td>
                  <td className={ui.td}>{t.equipmentLabel}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{dict.modules.maintenance.typeLabel[t.type as keyof typeof dict.modules.maintenance.typeLabel] ?? t.type}</td>
                  <td className={ui.td}>{dict.modules.maintenance.priorityLabel[t.priority as keyof typeof dict.modules.maintenance.priorityLabel] ?? t.priority}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${t.status === "COMPLETED" ? "bg-good-soft text-good" : t.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"}`}>
                      {dict.modules.maintenance.statusLabel[t.status as keyof typeof dict.modules.maintenance.statusLabel] ?? t.status}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{dt.date(t.createdAt)}</td>
                  <td className={ui.td}>{t.assignedTo?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(t.downtimeHours, 1)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt((t.laborCost ?? 0) + (t.partsCost ?? 0), 0)}</td>
                </tr>
              ))}
              {maintenanceData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
