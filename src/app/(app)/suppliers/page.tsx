import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { createSupplier, createMaterial } from "./actions";

export default async function SuppliersPage() {
  const [suppliers, materials] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { materials: true } } } }),
    prisma.material.findMany({ orderBy: { createdAt: "asc" }, include: { supplier: true } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 08 — Suppliers</div>
        <h1 className={ui.h1}>Suppliers &amp; material catalog</h1>
        <p className={ui.intro}>
          Vendor master for aggregate, cement and admixture suppliers. Each
          material carries the specific gravity and absorption used by the
          yield-factor and moisture-correction calculations on Mix Design.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Supplier</th>
                <th className={ui.th}>Catalog</th>
                <th className={ui.th}>Lead time</th>
                <th className={ui.th}>Materials</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td className={`${ui.td} font-medium`}>{s.name}</td>
                  <td className={ui.td}>{s.materialCatalog || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {s.leadTimeDays ? `${s.leadTimeDays}d` : "—"}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{s._count.materials}</td>
                </tr>
              ))}
              {suppliers.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">No suppliers yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createSupplier} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New supplier</h2>
          <div>
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} placeholder="Suez Aggregates Co." />
          </div>
          <div>
            <label className={ui.label}>Material catalog</label>
            <input name="materialCatalog" className={ui.input} placeholder="Coarse aggregate, sand" />
          </div>
          <div>
            <label className={ui.label}>Lead time (days)</label>
            <input name="leadTimeDays" type="number" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add supplier
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Material catalog</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Material</th>
                <th className={ui.th}>Type</th>
                <th className={ui.th}>Supplier</th>
                <th className={ui.th}>SG</th>
                <th className={ui.th}>Absorption %</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id}>
                  <td className={`${ui.td} font-medium`}>{m.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{m.type}</td>
                  <td className={ui.td}>{m.supplier?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{m.specificGravity ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{m.absorptionPct ?? "—"}</td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">No materials yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createMaterial} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New material</h2>
          <div>
            <label className={ui.label}>Supplier</label>
            <select name="supplierId" className={ui.select}>
              <option value="">Unassigned</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} placeholder="Coarse aggregate 20mm" />
          </div>
          <div>
            <label className={ui.label}>Type</label>
            <select name="type" required className={ui.select}>
              <option value="CEMENT">Cement</option>
              <option value="FLY_ASH">Fly ash</option>
              <option value="SAND">Sand</option>
              <option value="COARSE_AGGREGATE">Coarse aggregate</option>
              <option value="ADMIXTURE">Admixture</option>
              <option value="WATER">Water</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>Specific gravity</label>
            <input name="specificGravity" type="number" step="0.01" className={ui.input} placeholder="2.65" />
          </div>
          <div>
            <label className={ui.label}>Absorption %</label>
            <input name="absorptionPct" type="number" step="0.1" className={ui.input} placeholder="1.2" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add material
          </button>
        </form>
      </div>
    </div>
  );
}
