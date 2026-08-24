import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createReceipt, updateReceipt, deleteReceipt, returnReceiptToSupplier, setQcStatus } from "./actions";
import { createSupplier } from "../suppliers/actions";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";
import { SitePlantSelect } from "@/components/SitePlantSelect";

const qcChip: Record<string, string> = {
  PENDING: "bg-surface-alt text-ink-muted",
  PASSED: "bg-good-soft text-good",
  HELD: "bg-warn-soft text-warn",
  REJECTED: "bg-critical-soft text-critical",
  RETURNED: "bg-critical-soft text-critical",
};

export default async function MaterialReceivingPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; newSupplier?: string }>;
}) {
  const user = await requirePageAccess("material-receiving");
  const { dict } = await getDictionary();
  const m = dict.modules.materialReceiving;
  const { edit: editId, newSupplier } = await searchParams;
  const siteId = effectiveSiteId(user);

  const [receipts, sitesForPicker, suppliers, materials, silos, hoppers, deliveryDrivers] = await Promise.all([
    prisma.materialReceipt.findMany({
      where: { ...plantScopeWhere(siteId) },
      orderBy: { receivedAt: "desc" },
      include: {
        supplier: true,
        material: true,
        destinationSilo: true,
        destinationHopper: true,
        driver: true,
        plant: { include: { site: true } },
      },
    }),
    // Plant picker is Site (by code) first, then that site's own lines —
    // see SitePlantSelect.
    prisma.site.findMany({
      where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
      orderBy: { code: "asc" },
      include: { plants: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
    }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
    // Includes every silo/hopper at every line within the user's site, not
    // just their own line's — a shared destination (Silo/Hopper.
    // sharedAcrossPlants) only ever lives on some OTHER line at the same
    // site in the first place.
    prisma.silo.findMany({ where: { ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
    prisma.hopper.findMany({ where: { ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
    // Only the two roles a material delivery is ever attributed to — the
    // roster the select below offers, so choosing a name here can only ever
    // land on someone actually relevant to this ticket.
    prisma.employee.findMany({ where: { role: { in: ["BULKER_DRIVER", "WATER_TANKER_DRIVER"] }, ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.received}</th>
              <th className={ui.th}>{m.col.plant}</th>
              <th className={ui.th}>{m.col.supplierMaterial}</th>
              <th className={ui.th}>{m.col.po}</th>
              <th className={ui.th}>{m.col.netWeight}</th>
              <th className={ui.th}>{m.col.variance}</th>
              <th className={ui.th}>{m.col.destination}</th>
              <th className={ui.th}>{m.col.qcStatus}</th>
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => {
              const variancePct = r.orderedMassKg ? ((r.netWeightKg - r.orderedMassKg) / r.orderedMassKg) * 100 : null;
              const editable = !r.postedToInventory;

              if (editId === r.id && editable) {
                return (
                  <tr key={r.id}>
                    <td className={ui.td} colSpan={9}>
                      <form action={updateReceipt} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        <div>
                          <label className={ui.label}>{m.f.supplier}</label>
                          <select name="supplierId" defaultValue={r.supplierId} required className={`${ui.select} w-40`}>
                            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.material}</label>
                          <select name="materialId" defaultValue={r.materialId} required className={`${ui.select} w-40`}>
                            {materials.map((mt) => <option key={mt.id} value={mt.id}>{mt.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.poNumber}</label>
                          <input name="poNumber" defaultValue={r.poNumber ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.orderedQty}</label>
                          <input name="orderedMassKg" type="number" step="1" defaultValue={r.orderedMassKg ?? undefined} className={`${ui.input} w-28`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.moisture}</label>
                          <input name="moisturePct" type="number" step="0.1" defaultValue={r.moisturePct ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.grossWeight}</label>
                          <input name="grossWeightKg" type="number" step="1" defaultValue={r.grossWeightKg} required className={`${ui.input} w-28`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.tareWeight}</label>
                          <input name="tareWeightKg" type="number" step="1" defaultValue={r.tareWeightKg} required className={`${ui.input} w-28`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.destSilo}</label>
                          <select name="destinationSiloId" defaultValue={r.destinationSiloId ?? ""} className={`${ui.select} w-36`}>
                            <option value="">{dict.field.none}</option>
                            {silos.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.destHopper}</label>
                          <select name="destinationHopperId" defaultValue={r.destinationHopperId ?? ""} className={`${ui.select} w-36`}>
                            <option value="">{dict.field.none}</option>
                            {hoppers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.driver}</label>
                          <select name="driverId" defaultValue={r.driverId ?? ""} className={`${ui.select} w-40`}>
                            <option value="">{m.selectDriver}</option>
                            {deliveryDrivers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.driverName}</label>
                          <input name="driverName" defaultValue={r.driverName ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href="/material-receiving" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(r.receivedAt).toLocaleString()}</td>
                  <td className={ui.td}>
                    <div className="font-mono text-xs" dir="ltr">{r.plant.site.code}</div>
                    <div className="text-xs text-ink-muted">{r.plant.name}</div>
                  </td>
                  <td className={ui.td}>
                    {r.supplier.name}
                    <div className="text-xs text-ink-muted">{r.material.name}</div>
                    {(r.driver?.name ?? r.driverName) && (
                      <div className="text-xs text-ink-faint">{r.driver?.name ?? r.driverName}</div>
                    )}
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.poNumber || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {r.netWeightKg.toFixed(0)} kg
                    {r.moisturePct != null && <div className="text-xs text-ink-faint">{m.moisture(r.moisturePct)}</div>}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {variancePct != null ? (
                      <span className={Math.abs(variancePct) > 2 ? "text-critical" : "text-good"}>
                        {variancePct > 0 ? "+" : ""}
                        {variancePct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-ink-faint">{m.noPoQty}</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {r.destinationSilo?.name || r.destinationHopper?.name || "—"}
                    {(r.destinationSilo || r.destinationHopper) && (
                      <div className="text-xs text-ink-faint">
                        {(r.destinationSilo?.sharedAcrossPlants || r.destinationHopper?.sharedAcrossPlants) ? m.shared : m.dedicated}
                      </div>
                    )}
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${qcChip[r.qcStatus] ?? ""}`}>{dict.status[r.qcStatus as keyof typeof dict.status] ?? r.qcStatus}</span>
                  </td>
                  <td className={ui.td}>
                    {r.qcStatus !== "PASSED" && r.qcStatus !== "REJECTED" && r.qcStatus !== "RETURNED" && (
                      <div className="flex flex-wrap gap-1">
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="PASSED" />
                          <button className="rounded-md border border-good bg-good-soft px-2 py-1 text-xs text-good hover:opacity-80">
                            {m.pass}
                          </button>
                        </form>
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="HELD" />
                          <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                            {m.hold}
                          </button>
                        </form>
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="REJECTED" />
                          <button className="rounded-md border border-critical bg-critical-soft px-2 py-1 text-xs text-critical hover:opacity-80">
                            {m.reject}
                          </button>
                        </form>
                      </div>
                    )}
                    {r.qcStatus === "PASSED" && (
                      <span className="text-xs text-ink-faint">{m.postedToInventory}</span>
                    )}
                    <div className="mt-1 flex flex-wrap gap-2">
                      {editable && (
                        <Link href={`/material-receiving?edit=${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      )}
                      <form action={deleteReceipt}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{dict.field.delete}</button>
                      </form>
                      {r.qcStatus !== "RETURNED" && (
                        <form action={returnReceiptToSupplier}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className="text-xs font-medium text-critical hover:underline">{m.returnToSupplier}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {receipts.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={9}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {newSupplier && <form id="inline-new-supplier" action={createSupplier} />}
      <form action={createReceipt} className={`${ui.card} grid grid-cols-3 gap-4`}>
        <h2 className="col-span-3 font-display text-lg font-semibold">{m.captureTitle}</h2>
        <SitePlantSelect
          sites={sitesForPicker}
          required
          siteLabel={dict.field.siteCode}
          plantLabel={dict.field.plant}
          sitePlaceholder={dict.field.selectSite}
          plantPlaceholder={dict.field.selectPlant}
        />
        <div>
          <div className="flex items-center justify-between">
            <label className={ui.label}>{m.f.supplier}</label>
            {!newSupplier && (
              <Link href="/material-receiving?newSupplier=1" className="text-xs font-medium text-accent-strong hover:underline">
                {m.addSupplierInline}
              </Link>
            )}
          </div>
          {newSupplier ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <input form="inline-new-supplier" name="name" required placeholder={m.f.supplier} className={ui.input} />
              </div>
              <button form="inline-new-supplier" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                {m.addSupplierInlineSave}
              </button>
              <Link href="/material-receiving" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                {dict.field.cancel}
              </Link>
            </div>
          ) : (
            <select name="supplierId" required className={ui.select}>
              <option value="">{dict.field.selectSupplier}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={ui.label}>{m.f.material}</label>
          <select name="materialId" required className={ui.select}>
            <option value="">{dict.field.selectMaterial}</option>
            {materials.map((mt) => (
              <option key={mt.id} value={mt.id}>
                {mt.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.f.poNumber}</label>
          <input name="poNumber" className={ui.input} placeholder="PO-4471" dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.f.orderedQty}</label>
          <input name="orderedMassKg" type="number" step="1" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.f.moisture}</label>
          <input name="moisturePct" type="number" step="0.1" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.f.grossWeight}</label>
          <input name="grossWeightKg" type="number" step="1" required className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.f.tareWeight}</label>
          <input name="tareWeightKg" type="number" step="1" required className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.f.destSilo}</label>
          <select name="destinationSiloId" className={ui.select}>
            <option value="">{dict.field.none}</option>
            {silos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({dict.materialTypes[s.materialType as keyof typeof dict.materialTypes] ?? s.materialType})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.f.destHopper}</label>
          <select name="destinationHopperId" className={ui.select}>
            <option value="">{dict.field.none}</option>
            {hoppers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.aggregateType})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.f.driver}</label>
          <select name="driverId" className={ui.select}>
            <option value="">{m.selectDriver}</option>
            {deliveryDrivers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {dict.roles[e.role as keyof typeof dict.roles] ?? e.role}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.f.driverName}</label>
          <input name="driverName" className={ui.input} dir="ltr" />
        </div>
        <button type="submit" className={`${ui.button} col-span-3 justify-self-start`}>
          {m.capture}
        </button>
      </form>
    </div>
  );
}
