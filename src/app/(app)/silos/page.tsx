import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createSilo, updateSilo, updateSiloLevel, setSiloSharing, createHopper, updateHopperLevel, setHopperSharing, createChemicalTank, updateChemicalTankLevel } from "./actions";
import { getActiveSiteId, plantScopeWhere } from "@/lib/siteScope";
import { SitePlantSelect } from "@/components/SitePlantSelect";

function levelColor(pct: number, minPct: number) {
  if (pct <= minPct) return "bg-critical";
  if (pct <= minPct * 2) return "bg-warn";
  return "bg-good";
}

export default async function SilosPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const user = await requirePageAccess("silos");
  const { dict } = await getDictionary();
  const m = dict.modules.silos;
  const { edit: editId } = await searchParams;
  const siteId = await getActiveSiteId(user);

  const [silos, sitesForPicker, hoppers, chemicalTanks, admixtureMaterials] = await Promise.all([
    prisma.silo.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true }, orderBy: { createdAt: "asc" } }),
    // Plant picker is Site (by code) first, then that site's own lines —
    // see SitePlantSelect.
    prisma.site.findMany({
      where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
      orderBy: { code: "asc" },
      include: { plants: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
    }),
    prisma.hopper.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true }, orderBy: { createdAt: "asc" } }),
    prisma.chemicalTank.findMany({ where: { ...plantScopeWhere(siteId) }, include: { plant: true, material: true }, orderBy: { createdAt: "asc" } }),
    prisma.material.findMany({ where: { type: "ADMIXTURE" }, orderBy: { name: "asc" } }),
  ]);

  // Reorder list — "soonest to run out, first": every silo and hopper at
  // or below its low-level threshold (chemical tanks excluded, they have
  // no threshold field yet), ranked by how close to empty they are. Same
  // underlying comparison levelColor already makes visually, just pulled
  // out into a ranked, dedicated list rather than left implicit in a
  // color on the full silo/hopper tables below.
  const reorderList = [
    ...silos.map((s) => ({
      id: s.id,
      name: s.name,
      plantName: s.plant.name,
      pct: s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0,
      thresholdPct: s.minThresholdPct,
    })),
    ...hoppers.map((h) => ({
      id: h.id,
      name: h.name,
      plantName: h.plant.name,
      pct: h.capacityTons > 0 ? (h.currentLevelTons / h.capacityTons) * 100 : 0,
      thresholdPct: 15,
    })),
  ]
    .filter((r) => r.pct <= r.thresholdPct * 2)
    .sort((a, b) => a.pct - b.pct);
  const criticalCount = reorderList.filter((r) => r.pct <= r.thresholdPct).length;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.reorderTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.reorderIntro(reorderList.length, criticalCount)}</p>
        {reorderList.length > 0 ? (
          <div className={`${ui.card} flex flex-col gap-2`}>
            {reorderList.map((r) => (
              <div key={r.id} className="flex items-center gap-3 text-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${levelColor(r.pct, r.thresholdPct)}`} />
                <span className="w-40 shrink-0 font-medium" dir="ltr">{r.name}</span>
                <span className="flex-1 text-ink-muted">{r.plantName}</span>
                <span className="font-mono text-xs tabular" dir="ltr">{r.pct.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-good">{m.reorderEmpty}</p>
        )}
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={`${ui.card} flex flex-col gap-4`}>
          {silos.map((s) => {
            const pct = s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0;
            if (editId === s.id) {
              return (
                <form key={s.id} action={updateSilo} className="flex flex-wrap items-end gap-2 border-b border-border pb-4 last:border-0 last:pb-0">
                  <input type="hidden" name="id" value={s.id} />
                  <SitePlantSelect
                    sites={sitesForPicker}
                    defaultPlantId={s.plantId}
                    required
                    className={`${ui.select} w-36`}
                    siteLabel={dict.field.siteCode}
                    plantLabel={dict.field.plant}
                    sitePlaceholder={dict.field.selectSite}
                    plantPlaceholder={dict.field.selectPlant}
                  />
                  <div>
                    <label className={ui.label}>{m.f.name}</label>
                    <input name="name" defaultValue={s.name} required className={`${ui.input} w-24`} dir="ltr" />
                  </div>
                  <div>
                    <label className={ui.label}>{m.f.materialType}</label>
                    <select name="materialType" defaultValue={s.materialType} required className={`${ui.select} w-36`}>
                      <option value="CEMENT">{dict.materialTypes.CEMENT}</option>
                      <option value="FLY_ASH">{dict.materialTypes.FLY_ASH}</option>
                      <option value="SLAG">{dict.materialTypes.SLAG}</option>
                      <option value="SILICA_FUME">{dict.materialTypes.SILICA_FUME}</option>
                    </select>
                  </div>
                  <div>
                    <label className={ui.label}>{m.f.capacity}</label>
                    <input name="capacityTons" type="number" step="0.1" defaultValue={s.capacityTons} required className={`${ui.input} w-24`} />
                  </div>
                  <div>
                    <label className={ui.label}>{m.f.threshold}</label>
                    <input name="minThresholdPct" type="number" step="1" defaultValue={s.minThresholdPct} className={`${ui.input} w-20`} />
                  </div>
                  <button className={ui.button}>{dict.field.save}</button>
                  <Link href="/silos" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                    {dict.field.cancel}
                  </Link>
                </form>
              );
            }
            return (
              <div key={s.id} className="flex items-center gap-4">
                <div className="w-40 shrink-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-ink-muted">
                    {s.plant.name} · {dict.materialTypes[s.materialType as keyof typeof dict.materialTypes] ?? s.materialType}
                    {s.sharedAcrossPlants && <span className={`${ui.chip} bg-accent-soft text-accent-strong ms-1`}>{m.sharedBadge}</span>}
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
                <form action={setSiloSharing} className="shrink-0">
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="sharedAcrossPlants" value={s.sharedAcrossPlants ? "" : "on"} />
                  <button className="text-xs font-medium text-accent-strong hover:underline">
                    {s.sharedAcrossPlants ? m.unshareHopper : m.shareHopper}
                  </button>
                </form>
                <Link href={`/silos?edit=${s.id}`} className="shrink-0 text-xs font-medium text-accent-strong hover:underline">
                  {dict.field.edit}
                </Link>
              </div>
            );
          })}
          {silos.length === 0 && <p className="text-sm text-ink-muted">{m.empty}</p>}
        </div>

        <form action={createSilo} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <SitePlantSelect
            sites={sitesForPicker}
            required
            siteLabel={dict.field.siteCode}
            plantLabel={dict.field.plant}
            sitePlaceholder={dict.field.selectSite}
            plantPlaceholder={dict.field.selectPlant}
          />
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
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="sharedAcrossPlants" />
            {m.sharedAcrossPlantsLabel}
          </label>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.hoppersTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.hoppersIntro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={`${ui.card} flex flex-col gap-4`}>
            {hoppers.map((h) => {
              const pct = h.capacityTons > 0 ? (h.currentLevelTons / h.capacityTons) * 100 : 0;
              return (
                <div key={h.id} className="flex items-center gap-4">
                  <div className="w-40 shrink-0">
                    <div className="font-medium" dir="ltr">{h.name}</div>
                    <div className="text-xs text-ink-muted">
                      {h.plant.name} · {h.aggregateType}
                      {h.sharedAcrossPlants && <span className={`${ui.chip} bg-accent-soft text-accent-strong ms-1`}>{m.sharedBadge}</span>}
                    </div>
                  </div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-border bg-surface-alt">
                    <div className={`h-full rounded-full ${levelColor(pct, 15)}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                  </div>
                  <div className="w-32 shrink-0 font-mono text-xs text-ink-muted tabular" dir="ltr">
                    {h.currentLevelTons.toFixed(1)} / {h.capacityTons.toFixed(1)} t
                  </div>
                  <form action={updateHopperLevel} className="flex shrink-0 items-center gap-1">
                    <input type="hidden" name="id" value={h.id} />
                    <input
                      name="currentLevelTons"
                      type="number"
                      step="0.1"
                      defaultValue={h.currentLevelTons}
                      className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                    />
                    <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{m.update}</button>
                  </form>
                  <form action={setHopperSharing} className="shrink-0">
                    <input type="hidden" name="id" value={h.id} />
                    <input type="hidden" name="sharedAcrossPlants" value={h.sharedAcrossPlants ? "" : "on"} />
                    <button className="text-xs font-medium text-accent-strong hover:underline">
                      {h.sharedAcrossPlants ? m.unshareHopper : m.shareHopper}
                    </button>
                  </form>
                </div>
              );
            })}
            {hoppers.length === 0 && <p className="text-sm text-ink-muted">{m.emptyHoppers}</p>}
          </div>

          <form action={createHopper} className={`${ui.card} flex flex-col gap-3`}>
            <h2 className="font-display text-lg font-semibold">{m.newHopperTitle}</h2>
            <p className="text-xs text-ink-muted">{m.hopperSiteHint}</p>
            <div>
              <label className={ui.label}>{dict.field.siteCode}</label>
              <select name="siteId" required className={ui.select}>
                <option value="">{dict.field.selectSite}</option>
                {sitesForPicker.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.fHopper.name}</label>
              <input name="name" required className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.fHopper.aggregateType}</label>
              <select name="aggregateType" required className={ui.select}>
                <option value="SAND">{dict.materialTypes.SAND}</option>
                <option value="COARSE_AGGREGATE">{dict.materialTypes.COARSE_AGGREGATE}</option>
                <option value="WATER">{dict.materialTypes.WATER}</option>
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.fHopper.capacity}</label>
              <input name="capacityTons" type="number" step="0.1" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.fHopper.currentLevel}</label>
              <input name="currentLevelTons" type="number" step="0.1" defaultValue={0} className={ui.input} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="sharedAcrossPlants" defaultChecked />
              {m.sharedAcrossPlantsLabel}
            </label>
            <button type="submit" className={`${ui.button} mt-2`}>{m.addHopper}</button>
          </form>
        </div>
      </div>

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.tanksTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.tanksIntro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={`${ui.card} flex flex-col gap-4`}>
            {chemicalTanks.map((t) => {
              const pct = t.capacityLiters && t.capacityLiters > 0 ? (t.currentLevelLiters / t.capacityLiters) * 100 : 0;
              return (
                <div key={t.id} className="flex items-center gap-4">
                  <div className="w-40 shrink-0">
                    <div className="font-medium" dir="ltr">{t.name}</div>
                    <div className="text-xs text-ink-muted">{t.plant.name} · {t.material.name}</div>
                  </div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-border bg-surface-alt">
                    <div className={`h-full rounded-full ${levelColor(pct, 15)}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                  </div>
                  <div className="w-36 shrink-0 font-mono text-xs text-ink-muted tabular" dir="ltr">
                    {t.currentLevelLiters.toFixed(0)}{t.capacityLiters ? ` / ${t.capacityLiters.toFixed(0)}` : ""} L
                  </div>
                  <form action={updateChemicalTankLevel} className="flex shrink-0 items-center gap-1">
                    <input type="hidden" name="id" value={t.id} />
                    <input
                      name="currentLevelLiters"
                      type="number"
                      step="0.1"
                      defaultValue={t.currentLevelLiters}
                      className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                    />
                    <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{m.update}</button>
                  </form>
                </div>
              );
            })}
            {chemicalTanks.length === 0 && <p className="text-sm text-ink-muted">{m.emptyTanks}</p>}
          </div>

          <form action={createChemicalTank} className={`${ui.card} flex flex-col gap-3`}>
            <h2 className="font-display text-lg font-semibold">{m.newTankTitle}</h2>
            <SitePlantSelect
              sites={sitesForPicker}
              required
              siteLabel={dict.field.siteCode}
              plantLabel={dict.field.plant}
              sitePlaceholder={dict.field.selectSite}
              plantPlaceholder={dict.field.selectPlant}
            />
            <div>
              <label className={ui.label}>{m.fTank.material}</label>
              <select name="materialId" required className={ui.select}>
                <option value="">{dict.field.selectMaterial}</option>
                {admixtureMaterials.map((mt) => <option key={mt.id} value={mt.id}>{mt.name}</option>)}
              </select>
            </div>
            {admixtureMaterials.some((mt) => !mt.specificGravity) && (
              <p className="text-xs text-warn">{m.noSpecificGravityWarning}</p>
            )}
            <div>
              <label className={ui.label}>{m.fTank.name}</label>
              <input name="name" required className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.fTank.capacity}</label>
              <input name="capacityLiters" type="number" step="1" className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.fTank.currentLevel}</label>
              <input name="currentLevelLiters" type="number" step="0.1" defaultValue={0} className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.addTank}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
