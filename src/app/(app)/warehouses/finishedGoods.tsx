import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId } from "@/lib/siteScope";
import type { CurrentUser } from "@/lib/session";
import { createFinishedProduct, recordFinishedProductMovement } from "./actions";

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// New — side products (precast blocks, etc.), never the ready-mix concrete
// itself, which is delivered same-day and never warehoused. Deliberately
// simple: a catalog plus a manual IN/OUT movement log, same derived-balance
// shape as Spare Parts — no link to how "production" of these actually
// happens and no sales/shipment workflow (see the plan's scope note).
export async function FinishedGoodsTab({
  dict,
  user,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  user: CurrentUser | null;
}) {
  const m = dict.modules.warehouses.finishedGoods;
  const siteId = await getActiveSiteId(user);

  const [products, sitesForPicker, movements, allMovementTotals] = await Promise.all([
    prisma.finishedProduct.findMany({ orderBy: { name: "asc" } }),
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.finishedProductMovement.findMany({
      where: { ...(siteId ? { siteId } : {}) },
      include: { product: true, site: true, recordedBy: true },
      orderBy: { occurredAt: "desc" },
      take: 30,
    }),
    prisma.finishedProductMovement.findMany({ select: { productId: true, siteId: true, direction: true, quantity: true } }),
  ]);

  const siteByIdAll = new Map((await prisma.site.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
  const netQty = new Map<string, number>();
  for (const mv of allMovementTotals) {
    const key = `${mv.productId}::${mv.siteId}`;
    const delta = mv.direction === "IN" ? mv.quantity : -mv.quantity;
    netQty.set(key, (netQty.get(key) ?? 0) + delta);
  }
  const balanceRows = [...netQty.entries()]
    .map(([key, balance]) => {
      const [productId, rowSiteId] = key.split("::");
      const product = products.find((p) => p.id === productId);
      if (!product) return null;
      if (siteId && rowSiteId !== siteId) return null;
      return { key, product, site: siteByIdAll.get(rowSiteId), balance };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.product.name.localeCompare(b.product.name));

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.catalogTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.code}</th>
                <th className={ui.th}>{m.col.name}</th>
                <th className={ui.th}>{m.col.unit}</th>
                <th className={ui.th}>{m.col.price}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.code}</td>
                  <td className={ui.td}>{p.name}</td>
                  <td className={ui.td}>{p.unitOfMeasure}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p.unitPrice?.toFixed(2) ?? "—"}</td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.empty}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createFinishedProduct} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.code}</label>
            <input name="code" required className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.unitOfMeasure}</label>
            <input name="unitOfMeasure" required className={ui.input} placeholder="PIECE" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.unitPrice}</label>
            <input name="unitPrice" type="number" step="0.01" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.notes}</label>
            <input name="notes" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.add}</button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.balanceTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colBalance.product}</th>
              <th className={ui.th}>{m.colBalance.plant}</th>
              <th className={ui.th}>{m.colBalance.onHand}</th>
            </tr>
          </thead>
          <tbody>
            {balanceRows.map((r) => (
              <tr key={r.key}>
                <td className={ui.td}>{r.product.name} <span className="font-mono text-xs text-ink-muted" dir="ltr">({r.product.code})</span></td>
                <td className={ui.td}>{r.site ? `${r.site.code} — ${r.site.name}` : "—"}</td>
                <td className={`${ui.td} font-mono tabular font-semibold ${r.balance <= 0 ? "text-critical" : ""}`}>{r.balance}</td>
              </tr>
            ))}
            {balanceRows.length === 0 && (
              <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.emptyBalance}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.movementsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colMovement.date}</th>
                <th className={ui.th}>{m.colMovement.product}</th>
                <th className={ui.th}>{m.colMovement.plant}</th>
                <th className={ui.th}>{m.colMovement.direction}</th>
                <th className={ui.th}>{m.colMovement.quantity}</th>
                <th className={ui.th}>{m.colMovement.recordedBy}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((mv) => (
                <tr key={mv.id}>
                  <td className={ui.td}>{fmtDate(mv.occurredAt)}</td>
                  <td className={ui.td}>{mv.product.name}</td>
                  <td className={ui.td}>{mv.site.code}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${mv.direction === "IN" ? "bg-good-soft text-good" : "bg-accent-soft text-accent-strong"}`}>
                      {m.directionLabel[mv.direction as keyof typeof m.directionLabel] ?? mv.direction}
                    </span>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{mv.quantity}</td>
                  <td className={ui.td}>{mv.recordedBy.name}</td>
                </tr>
              ))}
              {movements.length === 0 && (
                <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.emptyMovements}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={recordFinishedProductMovement} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.movementTitle}</h2>
          <div>
            <label className={ui.label}>{m.f2.productId}</label>
            <select name="productId" required className={ui.select}>
              <option value="" disabled>{m.f2.productId}</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.siteId}</label>
            <select name="siteId" required className={ui.select}>
              {sitesForPicker.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.direction}</label>
            <select name="direction" required className={ui.select}>
              <option value="IN">{m.directionLabel.IN}</option>
              <option value="OUT">{m.directionLabel.OUT}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.quantity}</label>
            <input name="quantity" type="number" step="0.01" min="0.01" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f2.notes}</label>
            <input name="notes" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.record}</button>
        </form>
      </div>
    </div>
  );
}
