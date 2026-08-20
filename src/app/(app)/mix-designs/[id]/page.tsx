import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { addComponent, setMixStatus } from "../actions";

export default async function MixDesignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("mix-designs");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.mixDesigns;
  const d = m.detail;

  const [mix, materials] = await Promise.all([
    prisma.mixDesign.findUnique({
      where: { id },
      include: { components: { include: { material: true } } },
    }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
  ]);

  if (!mix) notFound();

  // Absolute-volume method (ACI 211.1 style): each component's mass divided
  // by its specific-gravity-derived density, summed to a design volume.
  let designVolumeM3 = 0;
  let missingSg = 0;
  for (const c of mix.components) {
    const sg = c.material.specificGravity;
    if (!sg) {
      missingSg++;
      continue;
    }
    designVolumeM3 += c.designMassKgPerM3 / (sg * 1000);
  }
  const totalMassKg = mix.components.reduce((sum, c) => sum + c.designMassKgPerM3, 0);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{m.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">
            {mix.code} <span className="text-ink-muted">— {mix.grade}</span>
          </h1>
          <p className={ui.intro}>
            {d.exposure(mix.exposureClass || "—")} · {d.slumpTarget(mix.slumpTargetMm)} · {d.wc(mix.wcRatio)}
          </p>
        </div>
        <form action={setMixStatus} className="flex items-center gap-2">
          <input type="hidden" name="mixId" value={mix.id} />
          <select name="status" defaultValue={mix.status} className={`${ui.select} w-44`}>
            <option value="DRAFT">{dict.status.DRAFT}</option>
            <option value="PENDING_APPROVAL">{dict.status.PENDING_APPROVAL}</option>
            <option value="APPROVED">{dict.status.APPROVED}</option>
            <option value="RETIRED">{dict.status.RETIRED}</option>
          </select>
          <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
            {d.saveStatus}
          </button>
        </form>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.computedVolume}</div>
          <div className="mt-1 font-mono text-2xl tabular">{designVolumeM3.toFixed(3)} m³</div>
          {missingSg > 0 && (
            <p className="mt-1 text-xs text-warn">{d.missingSg(missingSg)}</p>
          )}
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.yieldTarget}</div>
          <div className="mt-1 font-mono text-2xl tabular">{mix.yieldTargetM3.toFixed(3)} m³</div>
          <p className="mt-1 text-xs text-ink-muted">{d.yieldNote}</p>
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.totalMass}</div>
          <div className="mt-1 font-mono text-2xl tabular">{totalMassKg.toFixed(0)} kg</div>
          <p className="mt-1 text-xs text-ink-muted">{d.totalMassNote((totalMassKg / 1000).toFixed(3))}</p>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.componentsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.col.material}</th>
                <th className={ui.th}>{d.col.type}</th>
                <th className={ui.th}>{d.col.designMass}</th>
                <th className={ui.th}>{d.col.tolerance}</th>
                <th className={ui.th}>{d.col.sg}</th>
              </tr>
            </thead>
            <tbody>
              {mix.components.map((c) => (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>{c.material.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{dict.materialTypes[c.material.type as keyof typeof dict.materialTypes] ?? c.material.type}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.designMassKgPerM3.toFixed(1)}</td>
                  <td className={`${ui.td} font-mono tabular`}>±{c.tolerancePct}%</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.material.specificGravity ?? "—"}</td>
                </tr>
              ))}
              {mix.components.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{d.emptyComponents}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={addComponent} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="mixId" value={mix.id} />
          <h2 className="font-display text-lg font-semibold">{d.addTitle}</h2>
          <div>
            <label className={ui.label}>{d.col.material}</label>
            <select name="materialId" required className={ui.select}>
              <option value="">{dict.field.selectMaterial}</option>
              {materials.map((mt) => (
                <option key={mt.id} value={mt.id}>
                  {mt.name} ({dict.materialTypes[mt.type as keyof typeof dict.materialTypes] ?? mt.type})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{d.designMassField}</label>
            <input name="designMassKgPerM3" type="number" step="0.1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{d.toleranceField}</label>
            <input name="tolerancePct" type="number" step="0.5" defaultValue={2} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {d.saveComponent}
          </button>
          <p className="text-xs text-ink-muted">
            {d.noMaterialHint}{" "}
            <a href="/suppliers" className="text-accent-strong hover:underline">
              {d.addInSuppliers}
            </a>
            .
          </p>
        </form>
      </div>
    </div>
  );
}
