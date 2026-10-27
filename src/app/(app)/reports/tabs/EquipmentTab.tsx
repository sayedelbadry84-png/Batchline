// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getEquipmentProductivityReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";

// One line per plant the asset worked at, e.g. "Riyadh 1: 4 / 31.5 m³".
// The parts always add up to the row's total (see getEquipmentProductivityReport).
function PlantBreakdown({ rows }: { rows: { plantId: string; plantName: string; tripCount: number; volumeM3: number }[] }) {
  return (
    <ul className="text-xs text-ink-muted">
      {rows.map((r) => (
        <li key={r.plantId}>{r.plantName}: <span className="font-mono tabular" dir="ltr">{r.tripCount} / {r.volumeM3.toFixed(1)} m³</span></li>
      ))}
    </ul>
  );
}

export function EquipmentTab({ equipmentData, scope, ctx }: {
  equipmentData: NonNullable<Awaited<ReturnType<typeof getEquipmentProductivityReport>>>;
  // "site": a site-pinned viewer sees only their site's contribution
  // (PM review 2026-10-27 P1-2); the totals are not the asset's totals.
  scope: "company" | "site";
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="equipment"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.equipment} ${rangeFrom} → ${rangeTo}\n${equipmentData.trucks.map((t) => `${t.code}: ${t.tripCount} trips, ${t.volumeM3.toFixed(1)} m³`).join("\n")}`}
          filenameBase={`equipment-${rangeFrom}-${rangeTo}`}
          headers={["From", "To", "Scope", "Type", "Code", "Plant", "Trips", "Volume m3"]}
          // One "All plants" total row per asset, then one row per plant it
          // worked at; the plant rows sum to the total row.
          rows={[
            ...equipmentData.trucks.flatMap((t) => [[rangeFrom, rangeTo, scope === "site" ? "This site only" : "Company", "Truck", t.code, scope === "site" ? "Site total" : "All plants", t.tripCount, t.volumeM3], ...t.byPlant.map((c) => [rangeFrom, rangeTo, scope === "site" ? "This site only" : "Company", "Truck", t.code, c.plantName, c.tripCount, c.volumeM3])]),
            ...equipmentData.pumps.flatMap((p) => [[rangeFrom, rangeTo, scope === "site" ? "This site only" : "Company", "Pump", p.code, scope === "site" ? "Site total" : "All plants", p.tripCount, p.volumeM3], ...p.byPlant.map((c) => [rangeFrom, rangeTo, scope === "site" ? "This site only" : "Company", "Pump", p.code, c.plantName, c.tripCount, c.volumeM3])]),
          ]}
        />
        <p className="text-sm text-ink-muted">{scope === "site" ? m.equipmentReport.siteScopeNote : m.equipmentReport.byPlantNote}</p>
        <div className="grid grid-cols-2 gap-6">
          <div className={ui.card}>
            <h2 className="mb-3 font-display text-base font-semibold">{m.equipmentReport.trucksTitle}</h2>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.equipmentReport.col.code}</th>
                  <th className={ui.th}>{m.equipmentReport.col.trips}</th>
                  <th className={ui.th}>{m.equipmentReport.col.volume}</th>
                  <th className={ui.th}>{m.equipmentReport.col.byPlant}</th>
                </tr>
              </thead>
              <tbody>
                {equipmentData.trucks.map((t) => (
                  <tr key={t.code}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.code}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.tripCount}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.volumeM3.toFixed(1)} m³</td>
                    <td className={ui.td}><PlantBreakdown rows={t.byPlant} /></td>
                  </tr>
                ))}
                {equipmentData.trucks.length === 0 && (
                  <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className={ui.card}>
            <h2 className="mb-3 font-display text-base font-semibold">{m.equipmentReport.pumpsTitle}</h2>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.equipmentReport.col.code}</th>
                  <th className={ui.th}>{m.equipmentReport.col.trips}</th>
                  <th className={ui.th}>{m.equipmentReport.col.volume}</th>
                  <th className={ui.th}>{m.equipmentReport.col.byPlant}</th>
                </tr>
              </thead>
              <tbody>
                {equipmentData.pumps.map((p) => (
                  <tr key={p.code}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.code}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p.tripCount}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p.volumeM3.toFixed(1)} m³</td>
                    <td className={ui.td}><PlantBreakdown rows={p.byPlant} /></td>
                  </tr>
                ))}
                {equipmentData.pumps.length === 0 && (
                  <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
  );
}
