// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { getIncentivesReport } from "../incentivesReport";
import { ExportBar, type ReportTabContext } from "../reportUi";
import { ui } from "@/lib/ui";

export function IncentivesTab({ incentivesData, ctx }: {
  incentivesData: NonNullable<Awaited<ReturnType<typeof getIncentivesReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="incentives"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.incentives} ${rangeFrom} → ${rangeTo}\n${incentivesData.byRole
            .flatMap((g) => g.rows.map((r) => `${r.name} (${dict.modules.incentives.roleLabel[g.role as keyof typeof dict.modules.incentives.roleLabel] ?? g.role}): ${r.payout.toFixed(0)}`))
            .join("\n")}`}
          filenameBase={`incentives-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Name", "Role", "Trips", "Volume m3", "Sites", "Payout"]}
          rows={incentivesData.byRole.flatMap((g) =>
            g.rows.map((r) => [rangeFrom, rangeTo, r.name, dict.modules.incentives.roleLabel[g.role as keyof typeof dict.modules.incentives.roleLabel] ?? g.role, r.tripCount, r.volumeM3, r.siteCount, r.payout]),
          )}
        />
        <p className="text-sm text-ink-muted">{m.incentivesReport.intro}</p>
        <div className={ui.card}>
          <div className="font-mono text-2xl tabular" dir="ltr">{incentivesData.totalPayout.toLocaleString()}</div>
          <div className="mt-1 text-sm text-ink-muted">{m.incentivesReport.col.payout}</div>
        </div>
        {incentivesData.byRole.map((group) => (
          <div key={group.role} className={ui.card}>
            <h2 className="mb-1 font-display text-base font-semibold">{dict.modules.incentives.roleLabel[group.role as keyof typeof dict.modules.incentives.roleLabel] ?? group.role}</h2>
            {group.volumeBased && <p className="mb-3 text-xs text-ink-muted">{m.incentivesReport.volumeBasedNote}</p>}
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.incentivesReport.col.name}</th>
                  {group.volumeBased ? (
                    <>
                      <th className={ui.th}>{m.incentivesReport.col.volume}</th>
                      <th className={ui.th}>{m.incentivesReport.col.sites}</th>
                    </>
                  ) : (
                    <th className={ui.th}>{m.incentivesReport.col.trips}</th>
                  )}
                  <th className={ui.th}>{m.incentivesReport.col.payout}</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((r) => (
                  <tr key={r.key}>
                    <td className={`${ui.td} font-medium`}>{r.name}</td>
                    {group.volumeBased ? (
                      <>
                        <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)} m³</td>
                        <td className={`${ui.td} font-mono tabular`}>{r.siteCount}</td>
                      </>
                    ) : (
                      <td className={`${ui.td} font-mono tabular`}>{r.tripCount}</td>
                    )}
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.payout.toLocaleString()}</td>
                  </tr>
                ))}
                {group.rows.length === 0 && (
                  <tr><td className={ui.td} colSpan={group.volumeBased ? 4 : 3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
  );
}
