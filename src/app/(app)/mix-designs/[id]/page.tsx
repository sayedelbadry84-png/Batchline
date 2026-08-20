import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { addComponent, setMixStatus } from "../actions";

export default async function MixDesignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("mix-designs");
  const { id } = await params;

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
          <div className={ui.eyebrow}>Module 01 — Mix Design</div>
          <h1 className={ui.h1}>
            {mix.code} <span className="text-ink-muted">— {mix.grade}</span>
          </h1>
          <p className={ui.intro}>
            Exposure {mix.exposureClass || "—"} · slump target {mix.slumpTargetMm} mm · w/c {mix.wcRatio}
          </p>
        </div>
        <form action={setMixStatus} className="flex items-center gap-2">
          <input type="hidden" name="mixId" value={mix.id} />
          <select name="status" defaultValue={mix.status} className={`${ui.select} w-44`}>
            <option value="DRAFT">Draft</option>
            <option value="PENDING_APPROVAL">Pending approval</option>
            <option value="APPROVED">Approved</option>
            <option value="RETIRED">Retired</option>
          </select>
          <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
            Save status
          </button>
        </form>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">Computed design volume</div>
          <div className="mt-1 font-mono text-2xl tabular">{designVolumeM3.toFixed(3)} m³</div>
          {missingSg > 0 && (
            <p className="mt-1 text-xs text-warn">
              {missingSg} component(s) missing specific gravity — excluded from volume.
            </p>
          )}
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">Yield target</div>
          <div className="mt-1 font-mono text-2xl tabular">{mix.yieldTargetM3.toFixed(3)} m³</div>
          <p className="mt-1 text-xs text-ink-muted">
            Actual yield factor (measured ÷ design) populates once batches are logged in Production.
          </p>
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">Total batched mass</div>
          <div className="mt-1 font-mono text-2xl tabular">{totalMassKg.toFixed(0)} kg</div>
          <p className="mt-1 text-xs text-ink-muted">≈ {(totalMassKg / 1000).toFixed(3)} t per m³ target</p>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Components (per m³)</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Material</th>
                <th className={ui.th}>Type</th>
                <th className={ui.th}>Design mass (kg)</th>
                <th className={ui.th}>Tolerance</th>
                <th className={ui.th}>SG</th>
              </tr>
            </thead>
            <tbody>
              {mix.components.map((c) => (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>{c.material.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{c.material.type}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.designMassKgPerM3.toFixed(1)}</td>
                  <td className={`${ui.td} font-mono tabular`}>±{c.tolerancePct}%</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.material.specificGravity ?? "—"}</td>
                </tr>
              ))}
              {mix.components.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">No components yet — add the mix recipe.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={addComponent} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="mixId" value={mix.id} />
          <h2 className="font-display text-lg font-semibold">Add / update component</h2>
          <div>
            <label className={ui.label}>Material</label>
            <select name="materialId" required className={ui.select}>
              <option value="">Select material…</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.type})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Design mass (kg per m³)</label>
            <input name="designMassKgPerM3" type="number" step="0.1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Batching tolerance (%)</label>
            <input name="tolerancePct" type="number" step="0.5" defaultValue={2} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Save component
          </button>
          <p className="text-xs text-ink-muted">
            No material you need?{" "}
            <a href="/suppliers" className="text-accent-strong hover:underline">
              Add it in Suppliers
            </a>
            .
          </p>
        </form>
      </div>
    </div>
  );
}
