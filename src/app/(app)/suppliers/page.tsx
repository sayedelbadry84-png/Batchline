import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createSupplier, createMaterial } from "./actions";

export default async function SuppliersPage() {
  await requirePageAccess("suppliers");
  const { dict } = await getDictionary();
  const m = dict.modules.suppliers;

  const [suppliers, materials] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { materials: true } } } }),
    prisma.material.findMany({ orderBy: { createdAt: "asc" }, include: { supplier: true } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.supplier}</th>
                <th className={ui.th}>{m.col.catalog}</th>
                <th className={ui.th}>{m.col.leadTime}</th>
                <th className={ui.th}>{m.col.materials}</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td className={`${ui.td} font-medium`}>{s.name}</td>
                  <td className={ui.td}>{s.materialCatalog || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s.leadTimeDays ? `${s.leadTimeDays}d` : "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{s._count.materials}</td>
                </tr>
              ))}
              {suppliers.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createSupplier} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} placeholder="Suez Aggregates Co." />
          </div>
          <div>
            <label className={ui.label}>{m.f.catalog}</label>
            <input name="materialCatalog" className={ui.input} placeholder="Coarse aggregate, sand" />
          </div>
          <div>
            <label className={ui.label}>{m.f.leadTime}</label>
            <input name="leadTimeDays" type="number" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.catalogTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colMaterials.material}</th>
                <th className={ui.th}>{m.colMaterials.type}</th>
                <th className={ui.th}>{m.colMaterials.supplier}</th>
                <th className={ui.th}>{m.colMaterials.sg}</th>
                <th className={ui.th}>{m.colMaterials.absorption}</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((mt) => (
                <tr key={mt.id}>
                  <td className={`${ui.td} font-medium`}>{mt.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{dict.materialTypes[mt.type as keyof typeof dict.materialTypes] ?? mt.type}</td>
                  <td className={ui.td}>{mt.supplier?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{mt.specificGravity ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{mt.absorptionPct ?? "—"}</td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.emptyMaterials}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createMaterial} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newMaterialTitle}</h2>
          <div>
            <label className={ui.label}>{m.fMaterial.supplier}</label>
            <select name="supplierId" className={ui.select}>
              <option value="">{dict.field.unassigned}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fMaterial.name}</label>
            <input name="name" required className={ui.input} placeholder="Coarse aggregate 20mm" />
          </div>
          <div>
            <label className={ui.label}>{m.fMaterial.type}</label>
            <select name="type" required className={ui.select}>
              <option value="CEMENT">{dict.materialTypes.CEMENT}</option>
              <option value="FLY_ASH">{dict.materialTypes.FLY_ASH}</option>
              <option value="SAND">{dict.materialTypes.SAND}</option>
              <option value="COARSE_AGGREGATE">{dict.materialTypes.COARSE_AGGREGATE}</option>
              <option value="ADMIXTURE">{dict.materialTypes.ADMIXTURE}</option>
              <option value="WATER">{dict.materialTypes.WATER}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fMaterial.sg}</label>
            <input name="specificGravity" type="number" step="0.01" className={ui.input} placeholder="2.65" />
          </div>
          <div>
            <label className={ui.label}>{m.fMaterial.absorption}</label>
            <input name="absorptionPct" type="number" step="0.1" className={ui.input} placeholder="1.2" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.addMaterial}
          </button>
        </form>
      </div>
    </div>
  );
}
