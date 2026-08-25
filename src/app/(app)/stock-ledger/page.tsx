import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";

export default async function StockLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const user = await requirePageAccess("stockLedger");
  const { dict } = await getDictionary();
  const m = dict.modules.stockLedger;
  const { site: siteParam } = await searchParams;
  const restrictedSiteId = effectiveSiteId(user);

  // Restricted to the caller's own plant (never more than one row per
  // material for them); every plant for ADMIN, since a physical
  // stockpile at one factory is never the same stock as another's —
  // blending them into one number would be simply wrong.
  const sites = await prisma.site.findMany({
    where: { ...(restrictedSiteId ? { id: restrictedSiteId } : {}) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  // A restricted (non-ADMIN) caller's own plant always wins; for an
  // unrestricted ADMIN, an explicit ?site= filter narrows the whole
  // ledger down to one plant — same pattern Reports uses for its site
  // filter. Left unset, ADMIN sees every plant's rows blended in below.
  const siteId = restrictedSiteId ?? (sites.some((s) => s.id === siteParam) ? siteParam! : null);

  const [materials, receipts, actuals] = await Promise.all([
    // Material is a global catalog (like MixDesign) — only the stock
    // movements (receipts/consumption) are site-specific.
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

  // Keyed by `${materialId}::${siteId}` — a material's balance is only ever
  // meaningful per physical plant (see the query comment above), never
  // blended across plants.
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

  // One row per (material, plant) that has any activity — for a
  // restricted (non-ADMIN) caller that's always their own single plant,
  // shown even with zero activity so the catalog stays complete; for
  // ADMIN, a material never received/consumed anywhere yet has no plant
  // to attribute it to, so it gets one unassigned row instead of one per
  // plant in the company.
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
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      {restrictedSiteId === null && (
        <form action="/stock-ledger" className="flex flex-wrap items-end gap-3">
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
                      href={`/stock-ledger/${mat.id}${rowSiteId ? `?site=${rowSiteId}` : ""}`}
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
