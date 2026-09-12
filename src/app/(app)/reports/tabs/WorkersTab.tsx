// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import Link from "next/link";
import { ExportBar, type ReportTabContext } from "../reportUi";
import { INCENTIVE_ROLE_KEYS, type IncentiveRoleKey } from "@/lib/incentives";
import { getWorkerProductivityReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

export function WorkersTab({ workersData, ctx, workerRole, siteId, plantId, fromRaw, toRaw }: {
  workersData: NonNullable<Awaited<ReturnType<typeof getWorkerProductivityReport>>>;
  ctx: ReportTabContext;
  workerRole: IncentiveRoleKey;
  siteId: string | undefined;
  plantId: string | undefined;
  fromRaw: string | undefined;
  toRaw: string | undefined;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  // This tab was the one block in the old page that already needed real
  // statements before its markup, so it lived there as an inline
  // `(() => { ... })()`. As its own component it is just a function body.
  const roleRows = workersData.rows.filter((r) => r.role === workerRole);
  const unit = workerRole === "BULKER_DRIVER" || workerRole === "WATER_TANKER_DRIVER" ? "t" : "m³";
  return (
      <div className="flex flex-col gap-4">
        <div className="no-print flex flex-wrap gap-1 border-b border-border">
          {INCENTIVE_ROLE_KEYS.map((r) => (
            <Link
              key={r}
              href={`/reports?tab=workers&role=${r}${siteId ? `&site=${siteId}` : ""}${plantId ? `&plant=${plantId}` : ""}${fromRaw ? `&from=${fromRaw}` : ""}${toRaw ? `&to=${toRaw}` : ""}`}
              className={`rounded-t-md px-3 py-1.5 text-sm ${
                workerRole === r ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {dict.modules.incentives.roleLabel[r]}
            </Link>
          ))}
        </div>
        <ExportBar
          m={m}
          tab="workers"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.workers} — ${dict.modules.incentives.roleLabel[workerRole]} ${rangeFrom} → ${rangeTo}\n${roleRows.map((r) => `${r.name}: ${r.count}`).join("\n")}`}
          filenameBase={`workers-${workerRole.toLowerCase()}-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Name", "Count", "Volume"]}
          rows={roleRows.map((r) => [rangeFrom, rangeTo, r.name, r.count, r.volumeM3])}
        />
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.workersReport.col.name}</th>
                <th className={ui.th}>{m.workersReport.col.count}</th>
                <th className={ui.th}>{m.workersReport.col.volume}</th>
              </tr>
            </thead>
            <tbody>
              {roleRows.map((r) => (
                <tr key={r.key}>
                  <td className={`${ui.td} font-medium`}>{r.name}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.count}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)} {unit}</td>
                </tr>
              ))}
              {roleRows.length === 0 && (
                <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
    </div>
  );
}
