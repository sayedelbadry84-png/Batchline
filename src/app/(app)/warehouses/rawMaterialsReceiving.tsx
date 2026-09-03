import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getDictionary } from "@/lib/i18n";
import { createReceipt, updateReceipt, deleteReceipt, returnReceiptToSupplier, setQcStatus } from "../material-receiving/actions";
import { createSupplier } from "../suppliers/actions";
import { plantScopeWhere } from "@/lib/siteScope";
import { SitePlantSelect } from "@/components/SitePlantSelect";

const qcChip: Record<string, string> = {
  PENDING: "bg-surface-alt text-ink-muted",
  PASSED: "bg-good-soft text-good",
  HELD: "bg-warn-soft text-warn",
  REJECTED: "bg-critical-soft text-critical",
  RETURNED: "bg-critical-soft text-critical",
};

// Relocated verbatim from the old standalone /material-receiving module
// (see material-receiving/actions.ts, unchanged) — see warehouses/page.tsx
// for the redirect and the rawMaterials tab router.
export async function RawMaterialsReceivingTab({
  dict,
  siteId,
  editId,
  newSupplier,
  baseUrl,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteId: string | null;
  editId?: string;
  newSupplier?: string;
  baseUrl: string;
}) {
  const m = dict.modules.materialReceiving;

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
        inspectedBy: true,
      },
    }),
    prisma.site.findMany({
      where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
      orderBy: { code: "asc" },
      include: { plants: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
    }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
    prisma.silo.findMany({ where: { ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
    prisma.hopper.findMany({ where: { ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { role: { in: ["BULKER_DRIVER", "WATER_TANKER_DRIVER"] }, ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
  ]);

  // materialId: { not: null } excludes spare-part lines — those receive
  // into the Spare Parts tab instead, not here.
  const openPoLinesRaw = await prisma.purchaseOrderLine.findMany({
    where: { purchaseOrder: { status: { in: ["SENT", "PARTIALLY_RECEIVED"] } }, materialId: { not: null } },
    include: { purchaseOrder: { include: { supplier: true } }, material: true },
    orderBy: { purchaseOrder: { orderDate: "desc" } },
  });
  const openPoLines = openPoLinesRaw as (typeof openPoLinesRaw[number] & { material: NonNullable<typeof openPoLinesRaw[number]["material"]>; orderedMassKg: number; receivedMassKg: number })[];

  return (
    <div className="flex flex-col gap-8">
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

              if (editId === r.id) {
                return (
                  <tr key={r.id}>
                    <td className={ui.td} colSpan={9}>
                      <form action={updateReceipt} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        {r.postedToInventory && (
                          <p className="w-full text-xs text-warn">{m.editLockedHint}</p>
                        )}
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
                        <Link href={baseUrl} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
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
                    {r.inspectedBy && (
                      <div className="mt-1 max-w-[16rem] text-xs text-ink-faint">
                        {m.inspectedBy(r.inspectedBy.name, new Date(r.inspectionDate!).toLocaleDateString())}
                        {r.inspectionNotes && <div className="italic">“{r.inspectionNotes}”</div>}
                      </div>
                    )}
                  </td>
                  <td className={ui.td}>
                    {r.qcStatus !== "PASSED" && r.qcStatus !== "REJECTED" && r.qcStatus !== "RETURNED" && (
                      <form action={setQcStatus} className="flex flex-col gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <textarea
                          name="inspectionNotes"
                          required
                          rows={2}
                          placeholder={m.inspectionNotesPlaceholder}
                          className="w-48 rounded-md border border-border bg-surface px-2 py-1 text-xs"
                        />
                        <div className="flex flex-wrap gap-1">
                          <button name="status" value="PASSED" className="rounded-md border border-good bg-good-soft px-2 py-1 text-xs text-good hover:opacity-80">
                            {m.pass}
                          </button>
                          <button name="status" value="HELD" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                            {m.hold}
                          </button>
                          <button name="status" value="REJECTED" className="rounded-md border border-critical bg-critical-soft px-2 py-1 text-xs text-critical hover:opacity-80">
                            {m.reject}
                          </button>
                        </div>
                      </form>
                    )}
                    {r.qcStatus === "PASSED" && (
                      <span className="text-xs text-ink-faint">{m.postedToInventory}</span>
                    )}
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Link href={`${baseUrl}&edit=${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
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
              <Link href={`${baseUrl}&newSupplier=1`} className="text-xs font-medium text-accent-strong hover:underline">
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
              <Link href={baseUrl} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
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
          <label className={ui.label}>{m.f.purchaseOrderLine}</label>
          <select name="purchaseOrderLineId" defaultValue="" className={ui.select}>
            <option value="">{dict.field.none}</option>
            {openPoLines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.purchaseOrder.poNumber} — {l.material.name} ({l.receivedMassKg.toFixed(0)}/{l.orderedMassKg.toFixed(0)} kg) — {l.purchaseOrder.supplier.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-muted">{m.purchaseOrderLineHint}</p>
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
