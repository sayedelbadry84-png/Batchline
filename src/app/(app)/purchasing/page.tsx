import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId, reservationSiteScopeWhere } from "@/lib/siteScope";
import { Modal } from "@/components/Modal";
import { PurchaseOrderLineRows } from "@/components/PurchaseOrderLineRows";
import {
  createPurchaseOrder,
  markPurchaseOrderSent,
  cancelPurchaseOrder,
  approvePurchaseOrder,
  createSupplierContract,
  terminateSupplierContract,
  renewSupplierContract,
  createPurchaseOrderFromRequisitions,
  createPurchaseOrderFromMaterialRequisitions,
} from "./actions";
import { resolvePlantIdForSite } from "@/lib/siteScope";
import { createSupplier, createMaterial, updateSupplier, updateMaterial } from "../suppliers/actions";

const PURCHASING_TABS = ["orders", "contracts", "suppliers"] as const;
type PurchasingTab = (typeof PURCHASING_TABS)[number];

const poStatusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  SENT: "bg-accent-soft text-accent-strong",
  PARTIALLY_RECEIVED: "bg-warn-soft text-warn",
  RECEIVED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    new?: string;
    newContract?: string;
    viewPO?: string;
    renew?: string;
    editSupplier?: string;
    editMaterial?: string;
    newFromReq?: string;
    newFromMaterialReq?: string;
  }>;
}) {
  const user = await requirePageAccess("purchasing");
  const { dict } = await getDictionary();
  const m = dict.modules.purchasing;
  const {
    tab: tabRaw,
    new: newFlag,
    newContract: newContractFlag,
    viewPO,
    renew: renewId,
    editSupplier: editSupplierId,
    editMaterial: editMaterialId,
    newFromReq: newFromReqFlag,
    newFromMaterialReq: newFromMaterialReqFlag,
  } = await searchParams;
  const tab: PurchasingTab = PURCHASING_TABS.includes(tabRaw as PurchasingTab) ? (tabRaw as PurchasingTab) : "orders";
  const siteId = await getActiveSiteId(user);
  const siteScope = reservationSiteScopeWhere(siteId);

  const [sites, suppliers, materials] = await Promise.all([
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
  ]);
  const contractRows = await prisma.supplierContract.findMany({
    where: { status: "ACTIVE", materialId: { not: null } },
    select: { supplierId: true, materialId: true, pricePerUnit: true },
  });
  const contracts = contractRows as { supplierId: string; materialId: string; pricePerUnit: number | null }[];

  const baseUrl = `/purchasing?tab=${tab}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {PURCHASING_TABS.map((t) => (
          <Link
            key={t}
            href={`/purchasing?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {m.tabs[t]}
          </Link>
        ))}
      </div>

      {tab === "orders" && (
        <OrdersTab
          m={m}
          dict={dict}
          siteScope={siteScope}
          sites={sites}
          suppliers={suppliers}
          materials={materials}
          contracts={contracts}
          newFlag={newFlag}
          viewPO={viewPO}
          newFromReqFlag={newFromReqFlag}
          newFromMaterialReqFlag={newFromMaterialReqFlag}
          baseUrl={baseUrl}
        />
      )}

      {tab === "contracts" && (
        <ContractsTab m={m} dict={dict} suppliers={suppliers} materials={materials} newContractFlag={newContractFlag} renewId={renewId} baseUrl={baseUrl} />
      )}

      {tab === "suppliers" && (
        <SuppliersTab dict={dict} editSupplierId={editSupplierId} editMaterialId={editMaterialId} baseUrl={baseUrl} />
      )}
    </div>
  );
}

async function OrdersTab({
  m,
  dict,
  siteScope,
  sites,
  suppliers,
  materials,
  contracts,
  newFlag,
  viewPO,
  newFromReqFlag,
  newFromMaterialReqFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["purchasing"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  suppliers: { id: string; name: string }[];
  materials: { id: string; name: string; type: string }[];
  contracts: { supplierId: string; materialId: string; pricePerUnit: number | null }[];
  newFlag?: string;
  viewPO?: string;
  newFromReqFlag?: string;
  newFromMaterialReqFlag?: string;
  baseUrl: string;
}) {
  const ordersRaw = await prisma.purchaseOrder.findMany({
    where: siteScope,
    orderBy: { createdAt: "desc" },
    include: { supplier: true, lines: { include: { material: true, sparePart: true } } },
  });

  // Same plant resolution createPurchaseOrder itself uses for currency/tax
  // — one lookup per distinct site among the fetched orders rather than
  // per order, then each order gets its own plant's poApprovalThreshold to
  // decide whether it's still waiting on approvePurchaseOrder.
  const thresholdBySite = new Map<string, number | null>();
  for (const siteId of new Set(ordersRaw.map((o) => o.siteId))) {
    const plantId = await resolvePlantIdForSite(siteId);
    const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId }, select: { poApprovalThreshold: true } }) : null;
    thresholdBySite.set(siteId, plant?.poApprovalThreshold ?? null);
  }
  const orders = ordersRaw.map((o) => {
    const threshold = thresholdBySite.get(o.siteId) ?? null;
    const needsApproval = !!threshold && o.total >= threshold && !o.approvedAt;
    return { ...o, needsApproval };
  });
  const viewedOrder = viewPO ? orders.find((o) => o.id === viewPO) : null;

  // Requisitions approved in Warehouses' Spare Parts tab, not yet turned
  // into a PO line — see createPurchaseOrderFromRequisitions.
  const pendingRequisitions = await prisma.sparePartsRequisition.findMany({
    where: { status: "APPROVED", ...siteScope },
    include: { sparePart: true, site: true },
    orderBy: { approvedAt: "asc" },
  });
  const sp = m.spareRequisitions;

  // Raw-material counterpart — auto-opened by completeBatch
  // (production/actions.ts) instead of raised by a person, same
  // APPROVED-and-not-yet-a-PO-line filter.
  const pendingMaterialRequisitions = await prisma.materialRequisition.findMany({
    where: { status: "APPROVED", ...siteScope },
    include: { material: true, site: true },
    orderBy: { approvedAt: "asc" },
  });
  const mp = m.materialRequisitions;

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap justify-end gap-2">
        {pendingRequisitions.length > 0 && (
          <Link href={`${baseUrl}&newFromReq=1`} className="rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent-strong hover:bg-accent-soft">
            {sp.newTitle} ({pendingRequisitions.length})
          </Link>
        )}
        {pendingMaterialRequisitions.length > 0 && (
          <Link href={`${baseUrl}&newFromMaterialReq=1`} className="rounded-md border border-accent px-4 py-2 text-sm font-medium text-accent-strong hover:bg-accent-soft">
            {mp.newTitle} ({pendingMaterialRequisitions.length})
          </Link>
        )}
        <Link href={`${baseUrl}&new=1`} className={ui.button}>+ {m.orders.newTitle}</Link>
      </div>

      {viewedOrder && (
        <div className={ui.card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">{viewedOrder.poNumber} — {viewedOrder.supplier.name}</h2>
            <Link href={baseUrl} className="text-xs font-medium text-accent-strong hover:underline">{dict.field.cancel}</Link>
          </div>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.orders.col.material}</th>
                <th className={ui.th}>{m.orders.col.ordered}</th>
                <th className={ui.th}>{m.orders.col.received}</th>
                <th className={ui.th}>{m.orders.col.unitPrice}</th>
                <th className={ui.th}>{m.orders.col.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {viewedOrder.lines.map((l) => (
                <tr key={l.id}>
                  <td className={ui.td}>{l.material?.name ?? l.sparePart?.name ?? "—"}</td>
                  <td className={`${ui.td} font-mono`}>{l.material ? `${(l.orderedMassKg ?? 0).toFixed(0)} kg` : (l.orderedQty ?? 0).toFixed(0)}</td>
                  <td className={`${ui.td} font-mono`}>{l.material ? `${(l.receivedMassKg ?? 0).toFixed(0)} kg` : (l.receivedQty ?? 0).toFixed(0)}</td>
                  <td className={`${ui.td} font-mono`}>{l.unitPrice.toFixed(2)}</td>
                  <td className={`${ui.td} font-mono`}>{l.lineTotal.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.orders.col.number}</th>
              <th className={ui.th}>{m.orders.col.supplier}</th>
              <th className={ui.th}>{m.orders.col.status}</th>
              <th className={ui.th}>{m.orders.col.total}</th>
              <th className={ui.th}>{m.orders.col.expected}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className={`${ui.td} font-mono text-xs`}>{o.poNumber}</td>
                <td className={ui.td}>{o.supplier.name}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${poStatusChip[o.status] ?? ""}`}>{m.orders.statusLabel[o.status as keyof typeof m.orders.statusLabel] ?? o.status}</span>
                  {o.needsApproval && <span className={`${ui.chip} bg-warn-soft text-warn ms-1`}>{m.orders.needsApproval}</span>}
                  {o.approvedAt && <span className={`${ui.chip} bg-good-soft text-good ms-1`}>{m.orders.approved}</span>}
                </td>
                <td className={`${ui.td} font-mono`}>{o.total.toFixed(2)} {o.currency}</td>
                <td className={ui.td}>{fmtDate(o.expectedDate)}</td>
                <td className={ui.td}>
                  <div className="flex flex-col gap-1">
                    <Link href={`${baseUrl}&viewPO=${o.id}`} className="text-xs font-medium text-accent-strong hover:underline">{m.orders.viewLines}</Link>
                    <Link href={`/purchasing/orders/${o.id}`} className="text-xs font-medium text-accent-strong hover:underline">{m.orders.print}</Link>
                    {o.status === "DRAFT" && o.needsApproval && (
                      <form action={approvePurchaseOrder}>
                        <input type="hidden" name="id" value={o.id} />
                        <button className="text-xs font-medium text-good hover:underline">{m.orders.approve}</button>
                      </form>
                    )}
                    {o.status === "DRAFT" && !o.needsApproval && (
                      <form action={markPurchaseOrderSent}>
                        <input type="hidden" name="id" value={o.id} />
                        <button className="text-xs font-medium text-accent-strong hover:underline">{m.orders.markSent}</button>
                      </form>
                    )}
                    {["DRAFT", "SENT"].includes(o.status) && (
                      <form action={cancelPurchaseOrder}>
                        <input type="hidden" name="id" value={o.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{m.orders.cancel}</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.orders.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newFlag === "1" && (
        <Modal title={m.orders.newTitle} closeHref={baseUrl}>
          <form action={createPurchaseOrder} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.orders.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.orders.f.expectedDate}</label>
              <input name="expectedDate" type="date" className={`${ui.input} w-48`} />
            </div>
            <PurchaseOrderLineRows
              suppliers={suppliers}
              materials={materials}
              contracts={contracts}
              labels={{
                supplier: m.orders.f.supplier,
                supplierPlaceholder: m.orders.f.supplierPlaceholder,
                materialPlaceholder: m.orders.f.materialPlaceholder,
                orderedMass: m.orders.f.orderedMass,
                unitPrice: m.orders.f.unitPrice,
                addAnother: m.orders.f.addAnother,
                remove: m.orders.f.remove,
                noPriceOnFile: m.orders.f.noPriceOnFile,
              }}
            />
            <div>
              <label className={ui.label}>{m.orders.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.orders.add}</button>
          </form>
        </Modal>
      )}

      {newFromReqFlag === "1" && (
        <Modal title={sp.newTitle} closeHref={baseUrl}>
          <form action={createPurchaseOrderFromRequisitions} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.orders.f.supplier}</label>
                <select name="supplierId" required className={ui.select}>
                  <option value="" disabled>{m.orders.f.supplierPlaceholder}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.orders.f.siteId}</label>
                <select name="siteId" required className={ui.select}>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-ink-muted">{sp.priceHint}</p>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{sp.col.number}</th>
                  <th className={ui.th}>{sp.col.part}</th>
                  <th className={ui.th}>{sp.col.quantity}</th>
                  <th className={ui.th}>{sp.col.unitPrice}</th>
                </tr>
              </thead>
              <tbody>
                {pendingRequisitions.map((r) => (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs`}>{r.requisitionNumber}</td>
                    <td className={ui.td}>{r.sparePart.name}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.quantityNeeded}</td>
                    <td className={ui.td}>
                      <input type="hidden" name="requisitionId" value={r.id} />
                      <input name="unitPrice" type="number" step="0.01" min="0" className={`${ui.input} w-28`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="submit" className={`${ui.button} mt-2`}>{sp.create}</button>
          </form>
        </Modal>
      )}

      {newFromMaterialReqFlag === "1" && (
        <Modal title={mp.newTitle} closeHref={baseUrl}>
          <form action={createPurchaseOrderFromMaterialRequisitions} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.orders.f.supplier}</label>
                <select name="supplierId" required className={ui.select}>
                  <option value="" disabled>{m.orders.f.supplierPlaceholder}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.orders.f.siteId}</label>
                <select name="siteId" required className={ui.select}>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-ink-muted">{mp.priceHint}</p>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{mp.col.number}</th>
                  <th className={ui.th}>{mp.col.material}</th>
                  <th className={ui.th}>{mp.col.quantity}</th>
                  <th className={ui.th}>{mp.col.unitPrice}</th>
                </tr>
              </thead>
              <tbody>
                {pendingMaterialRequisitions.map((r) => (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs`}>{r.requisitionNumber}</td>
                    <td className={ui.td}>{r.material.name}</td>
                    <td className={`${ui.td} font-mono tabular`}>{r.quantityNeededKg.toFixed(0)}</td>
                    <td className={ui.td}>
                      <input type="hidden" name="requisitionId" value={r.id} />
                      <input name="unitPrice" type="number" step="0.01" min="0" className={`${ui.input} w-28`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="submit" className={`${ui.button} mt-2`}>{mp.create}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function ContractsTab({
  m,
  dict,
  suppliers,
  materials,
  newContractFlag,
  renewId,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["purchasing"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  suppliers: { id: string; name: string }[];
  materials: { id: string; name: string; type: string }[];
  newContractFlag?: string;
  renewId?: string;
  baseUrl: string;
}) {
  const contracts = await prisma.supplierContract.findMany({
    orderBy: { createdAt: "desc" },
    include: { supplier: true, material: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newContract=1`} className={ui.button}>+ {m.contracts.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.contracts.col.number}</th>
              <th className={ui.th}>{m.contracts.col.supplier}</th>
              <th className={ui.th}>{m.contracts.col.material}</th>
              <th className={ui.th}>{m.contracts.col.price}</th>
              <th className={ui.th}>{m.contracts.col.period}</th>
              <th className={ui.th}>{m.contracts.col.status}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id}>
                <td className={`${ui.td} font-mono text-xs`}>{c.contractNumber}</td>
                <td className={ui.td}>{c.supplier.name}</td>
                <td className={ui.td}>{c.material?.name ?? "—"}</td>
                <td className={`${ui.td} font-mono`}>{c.pricePerUnit != null ? c.pricePerUnit.toFixed(2) : "—"}</td>
                <td className={ui.td}>{fmtDate(c.startDate)} — {c.endDate ? fmtDate(c.endDate) : "∞"}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${c.status === "ACTIVE" ? "bg-good-soft text-good" : "bg-surface-alt text-ink-muted"}`}>
                    {m.contracts.statusLabel[c.status as keyof typeof m.contracts.statusLabel] ?? c.status}
                  </span>
                </td>
                <td className={ui.td}>
                  {c.status === "ACTIVE" && renewId === c.id ? (
                    <form action={renewSupplierContract} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={c.id} />
                      <input
                        name="pricePerUnit"
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        autoFocus
                        defaultValue={c.pricePerUnit ?? ""}
                        className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm"
                      />
                      <button className="text-xs font-medium text-good hover:underline">{dict.field.save}</button>
                      <Link href={baseUrl} className="text-xs text-ink-muted hover:underline">{dict.field.cancel}</Link>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {c.status === "ACTIVE" && (
                        <>
                          <Link href={`${baseUrl}&renew=${c.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                            {m.contracts.renew}
                          </Link>
                          <form action={terminateSupplierContract}>
                            <input type="hidden" name="id" value={c.id} />
                            <button className="text-xs font-medium text-critical hover:underline">{m.contracts.terminate}</button>
                          </form>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {contracts.length === 0 && (
              <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.contracts.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newContractFlag === "1" && (
        <Modal title={m.contracts.newTitle} closeHref={baseUrl}>
          <form action={createSupplierContract} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.contracts.f.supplierId}</label>
              <select name="supplierId" required className={ui.select}>
                <option value="" disabled>{m.orders.f.supplierPlaceholder}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.contracts.f.materialId}</label>
              <select name="materialId" defaultValue="" className={ui.select}>
                <option value="">{dict.field.none}</option>
                {materials.map((mt) => (
                  <option key={mt.id} value={mt.id}>{mt.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.contracts.f.startDate}</label>
                <input name="startDate" type="date" required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.contracts.f.endDate}</label>
                <input name="endDate" type="date" className={ui.input} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.contracts.f.pricePerUnit}</label>
                <input name="pricePerUnit" type="number" step="0.01" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.contracts.f.paymentTerms}</label>
                <input name="paymentTerms" className={ui.input} placeholder="Net 30" />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.contracts.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.contracts.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

// Merged from the old standalone /suppliers module — same supplier
// roster + material catalog, now a third tab here since sourcing
// suppliers and materials is part of the same buying workflow as
// purchase orders and contracts. Fetches its own richer supplier/
// material shape (materialCatalog, leadTimeDays, brand, etc.) since the
// lightweight {id, name} lists PurchasingPage already fetches for the
// Orders/Contracts pickers don't carry those fields.
async function SuppliersTab({
  dict,
  editSupplierId,
  editMaterialId,
  baseUrl,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  editSupplierId?: string;
  editMaterialId?: string;
  baseUrl: string;
}) {
  const sm = dict.modules.suppliers;

  const [suppliers, materials] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { materials: true } } } }),
    prisma.material.findMany({ orderBy: { createdAt: "asc" }, include: { supplier: true } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{sm.col.supplier}</th>
                <th className={ui.th}>{sm.col.catalog}</th>
                <th className={ui.th}>{sm.col.leadTime}</th>
                <th className={ui.th}>{sm.col.materials}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) =>
                editSupplierId === s.id ? (
                  <tr key={s.id}>
                    <td className={ui.td} colSpan={5}>
                      <form action={updateSupplier} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={s.id} />
                        <div>
                          <label className={ui.label}>{sm.f.name}</label>
                          <input name="name" defaultValue={s.name} required className={`${ui.input} w-44`} />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.f.catalog}</label>
                          <input name="materialCatalog" defaultValue={s.materialCatalog ?? ""} className={`${ui.input} w-44`} />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.f.leadTime}</label>
                          <input name="leadTimeDays" type="number" defaultValue={s.leadTimeDays ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href={baseUrl} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id}>
                    <td className={`${ui.td} font-medium`}>{s.name}</td>
                    <td className={ui.td}>{s.materialCatalog || "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{s.leadTimeDays ? `${s.leadTimeDays}d` : "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{s._count.materials}</td>
                    <td className={ui.td}>
                      <Link href={`${baseUrl}&editSupplier=${s.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {suppliers.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{sm.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createSupplier} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{sm.newTitle}</h2>
          <div>
            <label className={ui.label}>{sm.f.name}</label>
            <input name="name" required className={ui.input} placeholder="Suez Aggregates Co." />
          </div>
          <div>
            <label className={ui.label}>{sm.f.catalog}</label>
            <input name="materialCatalog" className={ui.input} placeholder="Coarse aggregate, sand" />
          </div>
          <div>
            <label className={ui.label}>{sm.f.leadTime}</label>
            <input name="leadTimeDays" type="number" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {sm.add}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{sm.catalogTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{sm.colMaterials.material}</th>
                <th className={ui.th}>{sm.colMaterials.type}</th>
                <th className={ui.th}>{sm.colMaterials.brand}</th>
                <th className={ui.th}>{sm.colMaterials.supplier}</th>
                <th className={ui.th}>{sm.colMaterials.sg}</th>
                <th className={ui.th}>{sm.colMaterials.absorption}</th>
                <th className={ui.th}>{sm.colMaterials.lastUnitCost}</th>
                <th className={ui.th}>{sm.colMaterials.co2Factor}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((mt) =>
                editMaterialId === mt.id ? (
                  <tr key={mt.id}>
                    <td className={ui.td} colSpan={9}>
                      <form action={updateMaterial} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={mt.id} />
                        <div>
                          <label className={ui.label}>{sm.fMaterial.supplier}</label>
                          <select name="supplierId" defaultValue={mt.supplierId ?? ""} className={`${ui.select} w-40`}>
                            <option value="">{dict.field.unassigned}</option>
                            {suppliers.map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.name}</label>
                          <input name="name" defaultValue={mt.name} required className={`${ui.input} w-44`} />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.type}</label>
                          <select name="type" defaultValue={mt.type} required className={`${ui.select} w-40`}>
                            <option value="CEMENT">{dict.materialTypes.CEMENT}</option>
                            <option value="FLY_ASH">{dict.materialTypes.FLY_ASH}</option>
                            <option value="SAND">{dict.materialTypes.SAND}</option>
                            <option value="COARSE_AGGREGATE">{dict.materialTypes.COARSE_AGGREGATE}</option>
                            <option value="ADMIXTURE">{dict.materialTypes.ADMIXTURE}</option>
                            <option value="WATER">{dict.materialTypes.WATER}</option>
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.brand}</label>
                          <input name="brand" defaultValue={mt.brand ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.sg}</label>
                          <input name="specificGravity" type="number" step="0.01" defaultValue={mt.specificGravity ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.absorption}</label>
                          <input name="absorptionPct" type="number" step="0.1" defaultValue={mt.absorptionPct ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.lastUnitCost}</label>
                          <input name="lastUnitCost" type="number" step="0.0001" defaultValue={mt.lastUnitCost ?? undefined} className={`${ui.input} w-24`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{sm.fMaterial.co2Factor}</label>
                          <input name="co2FactorKgPerKg" type="number" step="0.001" defaultValue={mt.co2FactorKgPerKg ?? undefined} className={`${ui.input} w-24`} dir="ltr" />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href={baseUrl} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={mt.id}>
                    <td className={`${ui.td} font-medium`}>{mt.name}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{dict.materialTypes[mt.type as keyof typeof dict.materialTypes] ?? mt.type}</td>
                    <td className={ui.td} dir="ltr">{mt.brand || "—"}</td>
                    <td className={ui.td}>{mt.supplier?.name ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{mt.specificGravity ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>{mt.absorptionPct ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{mt.lastUnitCost ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{mt.co2FactorKgPerKg ?? "—"}</td>
                    <td className={ui.td}>
                      <Link href={`${baseUrl}&editMaterial=${mt.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {materials.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={9}>
                    <span className="text-ink-muted">{sm.emptyMaterials}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createMaterial} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{sm.newMaterialTitle}</h2>
          <div>
            <label className={ui.label}>{sm.fMaterial.supplier}</label>
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
            <label className={ui.label}>{sm.fMaterial.name}</label>
            <input name="name" required className={ui.input} placeholder="Coarse aggregate 20mm" />
          </div>
          <div>
            <label className={ui.label}>{sm.fMaterial.type}</label>
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
            <label className={ui.label}>{sm.fMaterial.brand}</label>
            <input name="brand" className={ui.input} dir="ltr" placeholder="BASIF, DCP…" />
          </div>
          <div>
            <label className={ui.label}>{sm.fMaterial.sg}</label>
            <input name="specificGravity" type="number" step="0.01" className={ui.input} placeholder="2.65" />
          </div>
          <div>
            <label className={ui.label}>{sm.fMaterial.absorption}</label>
            <input name="absorptionPct" type="number" step="0.1" className={ui.input} placeholder="1.2" />
          </div>
          <div>
            <label className={ui.label}>{sm.fMaterial.lastUnitCost}</label>
            <input name="lastUnitCost" type="number" step="0.0001" className={ui.input} dir="ltr" />
            <p className="mt-1 text-xs text-ink-muted">{sm.lastUnitCostHint}</p>
          </div>
          <div>
            <label className={ui.label}>{sm.fMaterial.co2Factor}</label>
            <input name="co2FactorKgPerKg" type="number" step="0.001" className={ui.input} dir="ltr" />
            <p className="mt-1 text-xs text-ink-muted">{sm.co2FactorHint}</p>
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {sm.addMaterial}
          </button>
        </form>
      </div>
    </div>
  );
}
