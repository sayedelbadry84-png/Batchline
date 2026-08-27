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
  createSupplierContract,
  terminateSupplierContract,
} from "./actions";

const PURCHASING_TABS = ["orders", "contracts"] as const;
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
  searchParams: Promise<{ tab?: string; new?: string; newContract?: string; viewPO?: string }>;
}) {
  const user = await requirePageAccess("purchasing");
  const { dict } = await getDictionary();
  const m = dict.modules.purchasing;
  const { tab: tabRaw, new: newFlag, newContract: newContractFlag, viewPO } = await searchParams;
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
          baseUrl={baseUrl}
        />
      )}

      {tab === "contracts" && (
        <ContractsTab m={m} dict={dict} suppliers={suppliers} materials={materials} newContractFlag={newContractFlag} baseUrl={baseUrl} />
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
  baseUrl: string;
}) {
  const orders = await prisma.purchaseOrder.findMany({
    where: siteScope,
    orderBy: { createdAt: "desc" },
    include: { supplier: true, lines: { include: { material: true } } },
  });
  const viewedOrder = viewPO ? orders.find((o) => o.id === viewPO) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
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
                  <td className={ui.td}>{l.material.name}</td>
                  <td className={`${ui.td} font-mono`}>{l.orderedMassKg.toFixed(0)} kg</td>
                  <td className={`${ui.td} font-mono`}>{l.receivedMassKg.toFixed(0)} kg</td>
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
                </td>
                <td className={`${ui.td} font-mono`}>{o.total.toFixed(2)} {o.currency}</td>
                <td className={ui.td}>{fmtDate(o.expectedDate)}</td>
                <td className={ui.td}>
                  <div className="flex flex-col gap-1">
                    <Link href={`${baseUrl}&viewPO=${o.id}`} className="text-xs font-medium text-accent-strong hover:underline">{m.orders.viewLines}</Link>
                    {o.status === "DRAFT" && (
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
    </div>
  );
}

async function ContractsTab({
  m,
  dict,
  suppliers,
  materials,
  newContractFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["purchasing"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  suppliers: { id: string; name: string }[];
  materials: { id: string; name: string; type: string }[];
  newContractFlag?: string;
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
                  {c.status === "ACTIVE" && (
                    <form action={terminateSupplierContract}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="text-xs font-medium text-critical hover:underline">{m.contracts.terminate}</button>
                    </form>
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
