import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createSilo, updateSiloLevel } from "./actions";

function levelColor(pct: number, minPct: number) {
  if (pct <= minPct) return "bg-critical";
  if (pct <= minPct * 2) return "bg-warn";
  return "bg-good";
}

export default async function SilosPage() {
  await requirePageAccess("silos");
  const { dict } = await getDictionary();
  const m = dict.modules.silos;

  const [silos, plants] = await Promise.all([
    prisma.silo.findMany({ include: { plant: true }, orderBy: { createdAt: "asc" } }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
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
                    {s.plant.name} · {dict.materialTypes[s.materialType as keyof typeof dict.materialTypes] ?? s.materialType}
                  </div>
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-border bg-surface-alt">
                  <div
                    className={`h-full rounded-full ${levelColor(pct, s.minThresholdPct)}`}
                    style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                  />
                </div>
                <div className="w-40 shrink-0 font-mono text-xs text-ink-muted tabular" dir="ltr">
                  {s.currentLevelTons.toFixed(1)} / {s.capacityTons.toFixed(1)} t ({pct.toFixed(0)}%)
                  <div className="text-ink-faint">
                    {s.lastSensorReadingAt ? m.sensorAt(new Date(s.lastSensorReadingAt).toLocaleTimeString()) : m.noSensorFeed}
                  </div>
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
                    {m.update}
                  </button>
                </form>
              </div>
            );
          })}
          {silos.length === 0 && <p className="text-sm text-ink-muted">{m.empty}</p>}
        </div>

        <form action={createSilo} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{dict.field.plant}</label>
            <select name="plantId" required className={ui.select}>
              <option value="">{dict.field.selectPlant}</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} placeholder="S-1" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.materialType}</label>
            <select name="materialType" required className={ui.select}>
              <option value="CEMENT">{dict.materialTypes.CEMENT}</option>
              <option value="FLY_ASH">{dict.materialTypes.FLY_ASH}</option>
              <option value="SLAG">{dict.materialTypes.SLAG}</option>
              <option value="SILICA_FUME">{dict.materialTypes.SILICA_FUME}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.capacity}</label>
            <input name="capacityTons" type="number" step="0.1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.currentLevel}</label>
            <input name="currentLevelTons" type="number" step="0.1" defaultValue={0} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.threshold}</label>
            <input name="minThresholdPct" type="number" step="1" defaultValue={15} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
