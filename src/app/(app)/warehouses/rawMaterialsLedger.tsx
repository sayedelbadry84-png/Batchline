import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getDictionary } from "@/lib/i18n";
import { plantScopeWhere } from "@/lib/siteScope";

// Relocated verbatim from the old standalone /stock-ledger module — no
// actions.ts, it's a purely derived report (received minus consumed, same
// convention the new Spare Parts warehouse balance table also follows). See
// warehouses/page.tsx for the redirect and the rawMaterials tab router, and
// warehouses/materials/[id]/page.tsx for the per-material drill-down
// (moved from stock-ledger/[id]).
export async function RawMaterialsLedgerTab({
  dict,
  restrictedSiteId,
  siteParam,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  restrictedSiteId: string | null;
  siteParam?: string;
}) {
  const m = dict.modules.stockLedger;

  const sites = await prisma.site.findMany({
    where: { ...(restrictedSiteId ? { id: restrictedSiteId } : {}) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const siteId = restrictedSiteId ?? (sites.some((s) => s.id === siteParam) ? siteParam! : null);

  const [materials, receipts, actuals] = await Promise.all([
    prisma.material.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.materialReceipt.findMany({
      where: { postedToInventory: true, ...plantScopeWhere(siteId) },
      select: { materialId: true, netWeightKg: true, plant: { select: { siteId: true } } },
    }),
    prisma.batchComponentActual.findMany({
      where: { batchTicket: { status: "COMPLETE", ...plantScopeWhere(siteId) } },
      select: { materialId: true, actualMassKg: true, targetMassKg: true, batchTicket: { select: { plant: { select: { siteId: true } } } } },
    }),
  ]);

  const inKg = new Map<string, number>();
  for (const r of receipts) {
    const key = `${r.materialId}::${r.plant.siteId}`;
    inKg.set(key, (inKg.get(key) ?? 0) + r.netWeightKg);
  }

  const outKg = new Map<string, number>();
  for (const a of actuals) {
    const key = `${a.materialId}::${a.batchTicket.plant.siteId}`;
    const mass = a.actualMassKg ?? a.targetMassKg;
    outKg.set(key, (outKg.get(key) ?? 0) + mass);
  }

  const rows: { material: (typeof materials)[number]; siteId: string | null }[] = [];
  for (const mat of materials) {
    if (siteId) {
      rows.push({ material: mat, siteId });
      continue;
    }
    const activeSiteIds = new Set<string>();
    for (const key of inKg.keys()) {
      const [matId, sid] = key.split("::");
      if (matId === mat.id) activeSiteIds.add(sid);
    }
    for (const key of outKg.keys()) {
      const [matId, sid] = key.split("::");
      if (matId === mat.id) activeSiteIds.add(sid);
    }
    if (activeSiteIds.size === 0) {
      rows.push({ material: mat, siteId: null });
    } else {
      for (const sid of activeSiteIds) rows.push({ material: mat, siteId: sid });
    }
  }
  rows.sort((a, b) => {
    const typeCmp = a.material.type.localeCompare(b.material.type);
    if (typeCmp !== 0) return typeCmp;
    const nameCmp = a.material.name.localeCompare(b.material.name);
    if (nameCmp !== 0) return nameCmp;
    return (a.siteId ?? "").localeCompare(b.siteId ?? "");
  });

  return (
    <div className="flex flex-col gap-8">
      {restrictedSiteId === null && (
        // A plain GET form submission replaces the URL's whole query string
        // with just this form's own fields — the hidden tab/sub inputs keep
        // the filter submit landing back on this same warehouses sub-tab
        // instead of dropping to the bare /warehouses default.
        <form action="/warehouses" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value="rawMaterials" />
          <input type="hidden" name="sub" value="ledger" />
          <div>
            <label className={ui.label}>{dict.field.siteCode}</label>
            <select name="site" defaultValue={siteId ?? ""} className={`${ui.select} w-56`}>
              <option value="">{m.detail.allPlants}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </select>
          </div>
          <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.applyFilter}</button>
        </form>
      )}

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.material}</th>
              <th className={ui.th}>{m.col.plant}</th>
              <th className={ui.th}>{m.col.type}</th>
              <th className={ui.th}>{m.col.received}</th>
              <th className={ui.th}>{m.col.consumed}</th>
              <th className={ui.th}>{m.col.balance}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ material: mat, siteId: rowSiteId }) => {
              const key = `${mat.id}::${rowSiteId}`;
              const received = inKg.get(key) ?? 0;
              const consumed = outKg.get(key) ?? 0;
              const balance = received - consumed;
              const site = rowSiteId ? siteById.get(rowSiteId) : null;
              return (
                <tr key={key}>
                  <td className={`${ui.td} font-medium`}>
                    {mat.name}
                    {mat.brand && <span className="ms-2 text-xs text-ink-muted" dir="ltr">({mat.brand})</span>}
                  </td>
                  <td className={ui.td}>
                    {site ? (
                      <>
                        <span className="font-mono text-xs" dir="ltr">{site.code}</span>
                        <div className="text-xs text-ink-muted">{site.name}</div>
                      </>
                    ) : (
                      <span className="text-ink-faint">{m.unassignedPlant}</span>
                    )}
                  </td>
                  <td className={ui.td}>{dict.materialTypes[mat.type as keyof typeof dict.materialTypes] ?? mat.type}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{received.toLocaleString()} kg</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{consumed.toLocaleString()} kg</td>
                  <td className={`${ui.td} font-mono tabular font-semibold ${balance < 0 ? "text-critical" : ""}`} dir="ltr">
                    {balance.toLocaleString()} kg
                  </td>
                  <td className={ui.td}>
                    <Link
                      href={`/warehouses/materials/${mat.id}${rowSiteId ? `?site=${rowSiteId}` : ""}`}
                      className="text-xs font-medium text-accent-strong hover:underline"
                    >
                      {m.viewLedger}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={7}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
