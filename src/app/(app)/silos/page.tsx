import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { createSilo, updateSiloLevel } from "./actions";

function levelColor(pct: number, minPct: number) {
  if (pct <= minPct) return "bg-critical";
  if (pct <= minPct * 2) return "bg-warn";
  return "bg-good";
}

export default async function SilosPage() {
  const [silos, plants] = await Promise.all([
    prisma.silo.findMany({ include: { plant: true }, orderBy: { createdAt: "asc" } }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 06 — Silos</div>
        <h1 className={ui.h1}>Silo status</h1>
        <p className={ui.intro}>
          Live cement, fly ash and SCM inventory by tank. A silo at or below
          its configured threshold is flagged red; below double the threshold,
          amber — matching the alert logic on the Production dashboard.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={`${ui.card} flex flex-col gap-4`}>
          {silos.map((s) => {
            const pct = s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0;
            return (
              <div key={s.id} className="flex items-center gap-4">
                <div className="w-40 shrink-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-ink-muted">
                    {s.plant.name} · {s.materialType}
                  </div>
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-border bg-surface-alt">
                  <div
                    className={`h-full rounded-full ${levelColor(pct, s.minThresholdPct)}`}
                    style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                  />
                </div>
                <div className="w-40 shrink-0 font-mono text-xs text-ink-muted tabular">
                  {s.currentLevelTons.toFixed(1)} / {s.capacityTons.toFixed(1)} t ({pct.toFixed(0)}%)
                </div>
                <form action={updateSiloLevel} className="flex shrink-0 items-center gap-1">
                  <input type="hidden" name="id" value={s.id} />
                  <input
                    name="currentLevelTons"
                    type="number"
                    step="0.1"
                    defaultValue={s.currentLevelTons}
                    className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                  />
                  <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                    Update
                  </button>
                </form>
              </div>
            );
          })}
          {silos.length === 0 && (
            <p className="text-sm text-ink-muted">No silos configured yet.</p>
          )}
        </div>

        <form action={createSilo} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New silo</h2>
          <div>
            <label className={ui.label}>Plant</label>
            <select name="plantId" required className={ui.select}>
              <option value="">Select plant…</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} placeholder="S-1" />
          </div>
          <div>
            <label className={ui.label}>Material type</label>
            <select name="materialType" required className={ui.select}>
              <option value="CEMENT">Cement (OPC)</option>
              <option value="FLY_ASH">Fly ash</option>
              <option value="SLAG">GGBS / slag</option>
              <option value="SILICA_FUME">Silica fume</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>Capacity (tons)</label>
            <input name="capacityTons" type="number" step="0.1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Current level (tons)</label>
            <input name="currentLevelTons" type="number" step="0.1" defaultValue={0} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Low-level threshold (%)</label>
            <input name="minThresholdPct" type="number" step="1" defaultValue={15} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add silo
          </button>
        </form>
      </div>
    </div>
  );
}
