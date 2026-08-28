import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { PrintButton } from "@/components/PrintButton";

const cellBorder = { border: "1px solid #000" };

// Same editable-print-preview pattern as production/[id]/delivery-note and
// sales/quotes/[id] — what prints is whatever's currently in the field,
// nothing here writes back to the stored PurchaseOrder/PurchaseOrderLine
// rows. See dict.modules.purchasing.orderDoc.editableHint.
function Cell({ label, value, className = "" }: { label: string; value: string | number | null; className?: string }) {
  return (
    <div style={cellBorder} className="px-2 py-1.5">
      <div style={{ fontSize: "10px" }} className="font-semibold leading-tight">{label}</div>
      <input
        type="text"
        defaultValue={value ?? ""}
        placeholder="—"
        dir="ltr"
        style={{ fontSize: "13px", color: "#000" }}
        className={`mt-0.5 w-full border-0 bg-transparent p-0 outline-none focus:bg-yellow-50 ${className}`}
      />
    </div>
  );
}

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("purchasing");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.purchasing;
  const d = m.orderDoc;

  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: true,
      site: true,
      createdBy: true,
      lines: { include: { material: true, sparePart: true } },
    },
  });
  if (!po) notFound();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="no-print flex items-center justify-between gap-3">
        <Link href="/purchasing?tab=orders" className="text-sm font-medium text-accent-strong hover:underline">
          ← {dict.field.cancel}
        </Link>
        <div className="flex items-center gap-3">
          <p className="text-xs text-ink-muted">{d.editableHint}</p>
          <PrintButton label={d.print} />
        </div>
      </div>

      <div dir="ltr" style={{ background: "#fff", color: "#000" }} className="flex flex-col gap-3 p-6">
        <div style={{ ...cellBorder }} className="p-2 text-center">
          <div className="text-lg font-bold">{d.docTitleAr}</div>
          <div className="text-base font-semibold">{d.docTitleEn}</div>
          <div className="mt-1 text-xs">{po.site.name} — {po.site.code}</div>
        </div>

        <div className="grid grid-cols-3">
          <Cell label={d.poNumber} value={po.poNumber} />
          <Cell label={d.date} value={new Date(po.orderDate).toLocaleDateString("en-GB")} className="text-center" />
          <Cell label={d.expectedDate} value={po.expectedDate ? new Date(po.expectedDate).toLocaleDateString("en-GB") : null} className="text-end" />
        </div>

        <div className="grid grid-cols-1">
          <Cell label={d.supplier} value={po.supplier.name} />
        </div>

        <div style={cellBorder}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-start font-semibold">{d.col.material}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-center font-semibold">{d.col.ordered}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-center font-semibold">{d.col.unitPrice}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-end font-semibold">{d.col.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-2 py-1.5 text-sm">{l.material?.name ?? l.sparePart?.name ?? "—"}</td>
                  <td className="px-2 py-1.5 text-center font-mono text-sm">
                    {l.material ? `${(l.orderedMassKg ?? 0).toFixed(0)} kg` : (l.orderedQty ?? 0).toFixed(0)}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono text-sm">{l.unitPrice.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-end font-mono text-sm">{l.lineTotal.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2">
          <div />
          <div style={cellBorder} className="p-2 text-end text-sm">
            <div className="flex justify-between"><span>{d.subtotal}</span><span className="font-mono">{po.subtotal.toFixed(2)} {po.currency}</span></div>
            <div className="flex justify-between"><span>{d.tax} ({po.taxRatePct}%)</span><span className="font-mono">{po.taxAmount.toFixed(2)} {po.currency}</span></div>
            <div className="mt-1 flex justify-between border-t border-black pt-1 font-bold"><span>{d.total}</span><span className="font-mono">{po.total.toFixed(2)} {po.currency}</span></div>
          </div>
        </div>

        {po.notes && (
          <div className="grid grid-cols-1">
            <Cell label={d.notes} value={po.notes} />
          </div>
        )}

        <div className="grid grid-cols-2">
          <Cell label={d.preparedBy} value={po.createdBy.name} />
          <Cell label={d.status} value={m.orders.statusLabel[po.status as keyof typeof m.orders.statusLabel] ?? po.status} className="text-end" />
        </div>
      </div>
    </div>
  );
}
