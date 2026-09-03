import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId } from "@/lib/siteScope";
import { getEquipmentOptions } from "@/lib/equipmentRegistry";
import { EquipmentPicker } from "@/components/EquipmentPicker";
import type { CurrentUser } from "@/lib/session";
import { createSparePart, receiveSparePart, issueSparePart, approveSparePartsRequisition, rejectSparePartsRequisition } from "./actions";

const requisitionStatusChip: Record<string, string> = {
  PENDING_APPROVAL: "bg-warn-soft text-warn",
  APPROVED: "bg-good-soft text-good",
  REJECTED: "bg-critical-soft text-critical",
  ORDERED: "bg-accent-soft text-accent-strong",
  FULFILLED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// New — the Maintenance module's own inventory, distinct from raw
// materials. See prisma/schema.prisma's SparePart/SparePartReceipt/
// SparePartsRequisition models and warehouses/actions.ts.
export async function SparePartsTab({
  dict,
  user,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  user: CurrentUser | null;
}) {
  const m = dict.modules.warehouses.spareParts;
  const siteId = await getActiveSiteId(user);

  const [spareParts, sitesForPicker, suppliers, receipts, allReceiptTotals, orderParts, directIssuances, allDirectIssuanceTotals, requisitions] = await Promise.all([
    prisma.sparePart.findMany({ include: { defaultSupplier: true }, orderBy: { name: "asc" } }),
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.sparePartReceipt.findMany({
      where: { ...(siteId ? { siteId } : {}) },
      include: { sparePart: true, site: true, receivedBy: true },
      orderBy: { receivedAt: "desc" },
      take: 30,
    }),
    // Unscoped and untruncated — the "recent receipts" list above is
    // limited to 30 rows for display, but the balance below needs every
    // receipt ever posted.
    prisma.sparePartReceipt.findMany({ select: { sparePartId: true, siteId: true, quantity: true } }),
    prisma.maintenanceOrderPart.findMany({
      include: { sparePart: true, order: { include: { ticket: { select: { siteId: true } } } } },
    }),
    prisma.sparePartIssuance.findMany({
      where: { ...(siteId ? { siteId } : {}) },
      include: { sparePart: true, site: true, issuedBy: true, maintenanceOrder: true },
      orderBy: { issuedAt: "desc" },
      take: 30,
    }),
    prisma.sparePartIssuance.findMany({ select: { sparePartId: true, siteId: true, quantity: true } }),
    prisma.sparePartsRequisition.findMany({
      where: { ...(siteId ? { siteId } : {}) },
      include: { sparePart: true, site: true, requestedBy: true, maintenanceOrder: { include: { ticket: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Optional picker for the receiving form below — every spare-part
  // PurchaseOrderLine still open (SENT or PARTIALLY_RECEIVED), same shape
  // as Material Receiving's own purchaseOrderLineId picker.
  const openPoLinesRaw = await prisma.purchaseOrderLine.findMany({
    where: { purchaseOrder: { status: { in: ["SENT", "PARTIALLY_RECEIVED"] } }, sparePartId: { not: null } },
    include: { purchaseOrder: { include: { supplier: true } }, sparePart: true },
    orderBy: { purchaseOrder: { orderDate: "desc" } },
  });
  const openPoLines = openPoLinesRaw as (typeof openPoLinesRaw[number] & { sparePart: NonNullable<typeof openPoLinesRaw[number]["sparePart"]>; orderedQty: number; receivedQty: number })[];

  // Picker for the issuance form's "which job was this for" field, shown
  // when the reason is MAINTENANCE — every order at this site, not just
  // open ones, since a part can reasonably get logged against a job
  // shortly after it's marked complete.
  const maintenanceOrders = await prisma.maintenanceOrder.findMany({
    where: siteId ? { ticket: { siteId } } : {},
    include: { ticket: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const equipmentOptions = await getEquipmentOptions(siteId);

  // Derived balance — receipts minus issuances, same convention as the
  // Raw Materials Stock Ledger tab.
  const inQty = new Map<string, number>();
  for (const r of allReceiptTotals) {
    const key = `${r.sparePartId}::${r.siteId}`;
    inQty.set(key, (inQty.get(key) ?? 0) + r.quantity);
  }
  const outQty = new Map<string, number>();
  for (const p of orderParts) {
    const key = `${p.sparePartId}::${p.order.ticket.siteId}`;
    outQty.set(key, (outQty.get(key) ?? 0) + p.quantity);
  }
  for (const i of allDirectIssuanceTotals) {
    const key = `${i.sparePartId}::${i.siteId}`;
    outQty.set(key, (outQty.get(key) ?? 0) + i.quantity);
  }
  const balanceKeys = new Set([...inQty.keys(), ...outQty.keys()]);
  const siteByIdAll = new Map((await prisma.site.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
  const balanceRows = [...balanceKeys]
    .map((key) => {
      const [sparePartId, rowSiteId] = key.split("::");
      const part = spareParts.find((sp) => sp.id === sparePartId);
      if (!part) return null;
      if (siteId && rowSiteId !== siteId) return null;
      return {
        key,
        part,
        site: siteByIdAll.get(rowSiteId),
        balance: (inQty.get(key) ?? 0) - (outQty.get(key) ?? 0),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.part.name.localeCompare(b.part.name));

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
                <th className={ui.th}>{m.col.category}</th>
                <th className={ui.th}>{m.col.unit}</th>
                <th className={ui.th}>{m.col.lastCost}</th>
              </tr>
            </thead>
            <tbody>
              {spareParts.map((sp) => (
                <tr key={sp.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{sp.code}</td>
                  <td className={ui.td}>{sp.name}</td>
                  <td className={ui.td}>{m.categoryLabel[sp.category as keyof typeof m.categoryLabel] ?? sp.category}</td>
                  <td className={ui.td}>{m.unitLabel[sp.unitOfMeasure as keyof typeof m.unitLabel] ?? sp.unitOfMeasure}</td>
                  <td className={`${ui.td} font-mono tabular`}>{sp.lastUnitCost?.toFixed(2) ?? "—"}</td>
                </tr>
              ))}
              {spareParts.length === 0 && (
                <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.empty}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createSparePart} className={`${ui.card} flex flex-col gap-3`}>
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
            <label className={ui.label}>{m.f.category}</label>
            <select name="category" required className={ui.select}>
              {Object.entries(m.categoryLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.unitOfMeasure}</label>
            <select name="unitOfMeasure" required className={ui.select}>
              {Object.entries(m.unitLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.reorderThreshold}</label>
            <input name="reorderThreshold" type="number" step="0.01" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.defaultSupplierId}</label>
            <select name="defaultSupplierId" defaultValue="" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.lastUnitCost}</label>
            <input name="lastUnitCost" type="number" step="0.01" className={ui.input} />
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
              <th className={ui.th}>{m.colBalance.part}</th>
              <th className={ui.th}>{m.colBalance.plant}</th>
              <th className={ui.th}>{m.colBalance.onHand}</th>
            </tr>
          </thead>
          <tbody>
            {balanceRows.map((r) => (
              <tr key={r.key}>
                <td className={ui.td}>{r.part.name} <span className="font-mono text-xs text-ink-muted" dir="ltr">({r.part.code})</span></td>
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
          <h2 className="mb-3 font-display text-lg font-semibold">{m.receiptsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colReceipt.number}</th>
                <th className={ui.th}>{m.colReceipt.part}</th>
                <th className={ui.th}>{m.colReceipt.plant}</th>
                <th className={ui.th}>{m.colReceipt.quantity}</th>
                <th className={ui.th}>{m.colReceipt.unitCost}</th>
                <th className={ui.th}>{m.colReceipt.receivedBy}</th>
                <th className={ui.th}>{m.colReceipt.date}</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs`}>{r.receiptNumber}</td>
                  <td className={ui.td}>{r.sparePart.name}</td>
                  <td className={ui.td}>{r.site.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.quantity}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.unitCost.toFixed(2)}</td>
                  <td className={ui.td}>{r.receivedBy.name}</td>
                  <td className={ui.td}>{fmtDate(r.receivedAt)}</td>
                </tr>
              ))}
              {receipts.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.emptyReceipts}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={receiveSparePart} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.receiveTitle}</h2>
          <div>
            <label className={ui.label}>{m.f2.sparePartId}</label>
            <select name="sparePartId" required className={ui.select}>
              <option value="" disabled>{m.f2.sparePartId}</option>
              {spareParts.map((sp) => <option key={sp.id} value={sp.id}>{sp.code} — {sp.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.siteId}</label>
            <select name="siteId" required className={ui.select}>
              {sitesForPicker.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.quantity}</label>
            <input name="quantity" type="number" step="0.01" min="0.01" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f2.unitCost}</label>
            <input name="unitCost" type="number" step="0.01" min="0.01" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f2.purchaseOrderLine}</label>
            <select name="purchaseOrderLineId" defaultValue="" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {openPoLines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.purchaseOrder.poNumber} — {l.sparePart.name} ({l.receivedQty.toFixed(0)}/{l.orderedQty.toFixed(0)}) — {l.purchaseOrder.supplier.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">{m.purchaseOrderLineHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f2.supplierId}</label>
            <select name="supplierId" defaultValue="" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f2.serialNumbers}</label>
            <input name="serialNumbers" className={ui.input} dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.receive}</button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.issuancesTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colIssuance.number}</th>
                <th className={ui.th}>{m.colIssuance.part}</th>
                <th className={ui.th}>{m.colIssuance.plant}</th>
                <th className={ui.th}>{m.colIssuance.quantity}</th>
                <th className={ui.th}>{m.colIssuance.reason}</th>
                <th className={ui.th}>{m.colIssuance.order}</th>
                <th className={ui.th}>{m.colIssuance.equipment}</th>
                <th className={ui.th}>{m.colIssuance.issuedBy}</th>
                <th className={ui.th}>{m.colIssuance.date}</th>
              </tr>
            </thead>
            <tbody>
              {directIssuances.map((i) => (
                <tr key={i.id}>
                  <td className={`${ui.td} font-mono text-xs`}>{i.issuanceNumber}</td>
                  <td className={ui.td}>{i.sparePart.name}</td>
                  <td className={ui.td}>{i.site.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>{i.quantity}</td>
                  <td className={ui.td}>{m.reasonLabel[i.reason as keyof typeof m.reasonLabel] ?? i.reason}</td>
                  <td className={ui.td}>
                    {i.maintenanceOrder ? (
                      <Link href={`/maintenance/orders/${i.maintenanceOrder.id}`} className="text-xs text-accent-strong hover:underline">
                        {i.maintenanceOrder.orderNumber}
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                  </td>
                  <td className={ui.td}>{i.equipmentLabel ? `${dict.modules.maintenance.equipmentTypeLabel[i.equipmentType as keyof typeof dict.modules.maintenance.equipmentTypeLabel] ?? i.equipmentType} — ${i.equipmentLabel}` : "—"}</td>
                  <td className={ui.td}>{i.issuedBy.name}</td>
                  <td className={ui.td}>{fmtDate(i.issuedAt)}</td>
                </tr>
              ))}
              {directIssuances.length === 0 && (
                <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.emptyIssuances}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={issueSparePart} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.issueTitle}</h2>
          <div>
            <label className={ui.label}>{m.f3.sparePartId}</label>
            <select name="sparePartId" required className={ui.select}>
              <option value="" disabled>{m.f3.sparePartId}</option>
              {spareParts.map((sp) => <option key={sp.id} value={sp.id}>{sp.code} — {sp.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f3.siteId}</label>
            <select name="siteId" required className={ui.select}>
              {sitesForPicker.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f3.quantity}</label>
            <input name="quantity" type="number" step="0.01" min="0.01" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f3.reason}</label>
            <select name="reason" required className={ui.select}>
              {Object.entries(m.reasonLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f3.maintenanceOrderId}</label>
            <select name="maintenanceOrderId" defaultValue="" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {maintenanceOrders.map((o) => (
                <option key={o.id} value={o.id}>{o.orderNumber} — {o.ticket.equipmentLabel}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">{m.f3.maintenanceOrderHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f3.equipmentId}</label>
            <EquipmentPicker
              options={equipmentOptions}
              placeholder={dict.modules.maintenance.tickets.f.equipmentPlaceholder}
              typeLabels={dict.modules.maintenance.equipmentTypeLabel}
              required={false}
            />
            <p className="mt-1 text-xs text-ink-muted">{m.f3.equipmentHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f3.unitCost}</label>
            <input name="unitCost" type="number" step="0.01" min="0" className={ui.input} />
            <p className="mt-1 text-xs text-ink-muted">{m.f3.unitCostHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f3.notes}</label>
            <input name="notes" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.issue}</button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.requisitionsTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colReq.number}</th>
              <th className={ui.th}>{m.colReq.part}</th>
              <th className={ui.th}>{m.colReq.plant}</th>
              <th className={ui.th}>{m.colReq.quantity}</th>
              <th className={ui.th}>{m.colReq.source}</th>
              <th className={ui.th}>{m.colReq.status}</th>
              <th className={ui.th}>{m.colReq.requestedBy}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {requisitions.map((r) => (
              <tr key={r.id}>
                <td className={`${ui.td} font-mono text-xs`}>{r.requisitionNumber}</td>
                <td className={ui.td}>{r.sparePart.name}</td>
                <td className={ui.td}>{r.site.code}</td>
                <td className={`${ui.td} font-mono tabular`}>{r.quantityNeeded}</td>
                <td className={ui.td}>
                  {r.maintenanceOrder ? (
                    <Link href={`/maintenance/orders/${r.maintenanceOrder.id}`} className="text-xs text-accent-strong hover:underline">
                      {m.fromOrder(r.maintenanceOrder.orderNumber)}
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-muted">{m.manualRequest}</span>
                  )}
                </td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${requisitionStatusChip[r.status] ?? ""}`}>{m.statusLabel[r.status as keyof typeof m.statusLabel] ?? r.status}</span>
                </td>
                <td className={ui.td}>{r.requestedBy.name}</td>
                <td className={ui.td}>
                  {r.status === "PENDING_APPROVAL" && (
                    <div className="flex flex-col gap-1">
                      <form action={approveSparePartsRequisition}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-xs font-medium text-good hover:underline">{m.approve}</button>
                      </form>
                      <form action={rejectSparePartsRequisition}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{m.reject}</button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {requisitions.length === 0 && (
              <tr><td className={ui.td} colSpan={8}><span className="text-ink-muted">{m.emptyRequisitions}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
