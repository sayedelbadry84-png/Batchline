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

export function EquipmentTab({ equipmentData, ctx }: {
  equipmentData: NonNullable<Awaited<ReturnType<typeof getEquipmentProductivityReport>>>;
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
          headers={["From", "To", "Type", "Code", "Trips", "Volume m3"]}
          rows={[
            ...equipmentData.trucks.map((t) => [rangeFrom, rangeTo, "Truck", t.code, t.tripCount, t.volumeM3]),
            ...equipmentData.pumps.map((p) => [rangeFrom, rangeTo, "Pump", p.code, p.tripCount, p.volumeM3]),
          ]}
        />
        <div className="grid grid-cols-2 gap-6">
          <div className={ui.card}>
            <h2 className="mb-3 font-display text-base font-semibold">{m.equipmentReport.trucksTitle}</h2>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.equipmentReport.col.code}</th>
                  <th className={ui.th}>{m.equipmentReport.col.trips}</th>
                  <th className={ui.th}>{m.equipmentReport.col.volume}</th>
                </tr>
              </thead>
              <tbody>
                {equipmentData.trucks.map((t) => (
                  <tr key={t.code}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.code}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.tripCount}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.volumeM3.toFixed(1)} m³</td>
                  </tr>
                ))}
                {equipmentData.trucks.length === 0 && (
                  <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
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
                </tr>
              </thead>
              <tbody>
                {equipmentData.pumps.map((p) => (
                  <tr key={p.code}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.code}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p.tripCount}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p.volumeM3.toFixed(1)} m³</td>
                  </tr>
                ))}
                {equipmentData.pumps.length === 0 && (
                  <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.noRows}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
  );
}
