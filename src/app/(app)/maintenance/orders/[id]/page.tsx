import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId } from "@/lib/siteScope";
import { Modal } from "@/components/Modal";
import {
  startMaintenanceOrder,
  completeMaintenanceOrder,
  cancelMaintenanceOrder,
  addOrderTechnician,
  removeOrderTechnician,
  issueSparePartToOrder,
} from "../../actions";

const statusChip: Record<string, string> = {
  OPEN: "bg-warn-soft text-warn",
  IN_PROGRESS: "bg-accent-soft text-accent-strong",
  COMPLETED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default async function MaintenanceOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ complete?: string }>;
}) {
  const user = await requirePageAccess("maintenance");
  const { id } = await params;
  const { complete: completeFlag } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.maintenance;
  const d = m.orderDetail;

  const order = await prisma.maintenanceOrder.findUnique({
    where: { id },
    include: {
      ticket: true,
      technicians: { include: { employee: true }, orderBy: { createdAt: "asc" } },
      parts: { include: { sparePart: true, issuedBy: true }, orderBy: { issuedAt: "asc" } },
      requisitions: { include: { sparePart: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) notFound();

  const siteId = await getActiveSiteId(user);
  if (siteId !== null && order.ticket.siteId !== siteId) notFound();

  const [employees, spareParts] = await Promise.all([
    prisma.employee.findMany({
      where: { status: "ACTIVE", plant: { siteId: order.ticket.siteId } },
      orderBy: { name: "asc" },
    }),
    prisma.sparePart.findMany({ orderBy: { name: "asc" } }),
  ]);

  const baseUrl = `/maintenance/orders/${id}`;
  const partsCost = order.parts.reduce((sum, p) => sum + p.lineTotal, 0);
  const canAct = ["OPEN", "IN_PROGRESS"].includes(order.status);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{d.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">{order.orderNumber}</h1>
          <p className={ui.intro}>
            {d.ticketLabel}: {order.ticket.ticketNumber} — {order.ticket.equipmentLabel}
          </p>
          {order.ticket.faultDescription && (
            <p className="mt-1 text-sm text-ink-muted">{d.faultLabel}: {order.ticket.faultDescription}</p>
          )}
        </div>
        <span className={`${ui.chip} ${statusChip[order.status] ?? ""}`}>
          {m.statusLabel[order.status as keyof typeof m.statusLabel] ?? order.status}
        </span>
      </header>

      <div className="no-print flex flex-wrap gap-2">
        {order.status === "OPEN" && (
          <form action={startMaintenanceOrder}>
            <input type="hidden" name="id" value={order.id} />
            <button className={ui.button}>{d.start}</button>
          </form>
        )}
        {canAct && (
          <Link href={`${baseUrl}?complete=1`} className="rounded-md border border-good px-4 py-2 text-sm font-medium text-good hover:bg-good-soft">
            {d.completeTitle}
          </Link>
        )}
        {canAct && (
          <form action={cancelMaintenanceOrder}>
            <input type="hidden" name="id" value={order.id} />
            <button className="rounded-md border border-critical px-4 py-2 text-sm font-medium text-critical hover:bg-critical-soft">{d.cancel}</button>
          </form>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.techniciansTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.colTech.name}</th>
                <th className={ui.th}>{d.colTech.role}</th>
                <th className={ui.th}>{d.colTech.hours}</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {order.technicians.map((t) => (
                <tr key={t.id}>
                  <td className={ui.td}>{t.employee.name}</td>
                  <td className={ui.td}>{t.employee.role}</td>
                  <td className={`${ui.td} font-mono tabular`}>{t.hoursWorked ?? "—"}</td>
                  <td className={ui.td}>
                    {canAct && (
                      <form action={removeOrderTechnician}>
                        <input type="hidden" name="id" value={t.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{d.removeTechnician}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {order.technicians.length === 0 && (
                <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{d.noTechnicians}</span></td></tr>
              )}
            </tbody>
          </table>

          {canAct && (
            <form action={addOrderTechnician} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <input type="hidden" name="orderId" value={order.id} />
              <div>
                <label className={ui.label}>{d.fTech.employeeId}</label>
                <select name="employeeId" required className={`${ui.select} w-44`}>
                  <option value="" disabled>{d.fTech.employeePlaceholder}</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name} — {e.role}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{d.fTech.hoursWorked}</label>
                <input name="hoursWorked" type="number" step="0.5" className={`${ui.input} w-28`} />
              </div>
              <button className={ui.button}>{d.addTechnician}</button>
            </form>
          )}
        </div>

        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.requisitionsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.colReq.number}</th>
                <th className={ui.th}>{d.colReq.part}</th>
                <th className={ui.th}>{d.colReq.quantity}</th>
                <th className={ui.th}>{d.colReq.status}</th>
              </tr>
            </thead>
            <tbody>
              {order.requisitions.map((r) => (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs`}>{r.requisitionNumber}</td>
                  <td className={ui.td}>{r.sparePart.name}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.quantityNeeded}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${r.status === "PENDING_APPROVAL" ? "bg-warn-soft text-warn" : r.status === "REJECTED" || r.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-good-soft text-good"}`}>
                      {d.requisitionStatusLabel[r.status as keyof typeof d.requisitionStatusLabel] ?? r.status}
                    </span>
                  </td>
                </tr>
              ))}
              {order.requisitions.length === 0 && (
                <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{d.noRequisitions}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{d.partsTitle}</h2>
        <p className="mb-3 text-xs text-ink-muted">{d.partShortfallHint}</p>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{d.colPart.part}</th>
              <th className={ui.th}>{d.colPart.quantity}</th>
              <th className={ui.th}>{d.colPart.unitCost}</th>
              <th className={ui.th}>{d.colPart.lineTotal}</th>
              <th className={ui.th}>{d.colPart.serialNumber}</th>
              <th className={ui.th}>{d.colPart.issuedBy}</th>
            </tr>
          </thead>
          <tbody>
            {order.parts.map((p) => (
              <tr key={p.id}>
                <td className={ui.td}>{p.sparePart.name}</td>
                <td className={`${ui.td} font-mono tabular`}>{p.quantity}</td>
                <td className={`${ui.td} font-mono tabular`}>{p.unitCost.toFixed(2)}</td>
                <td className={`${ui.td} font-mono tabular`}>{p.lineTotal.toFixed(2)}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.serialNumber ?? "—"}</td>
                <td className={ui.td}>{p.issuedBy.name} · {fmtDateTime(p.issuedAt)}</td>
              </tr>
            ))}
            {order.parts.length === 0 && (
              <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{d.noParts}</span></td></tr>
            )}
            {order.parts.length > 0 && (
              <tr>
                <td className={ui.td} colSpan={3}></td>
                <td className={`${ui.td} font-mono font-semibold tabular`}>{partsCost.toFixed(2)}</td>
                <td className={ui.td} colSpan={2}></td>
              </tr>
            )}
          </tbody>
        </table>

        {canAct && (
          <form action={issueSparePartToOrder} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <input type="hidden" name="orderId" value={order.id} />
            <div>
              <label className={ui.label}>{d.fPart.sparePartId}</label>
              <select name="sparePartId" required className={`${ui.select} w-48`}>
                <option value="" disabled>{d.fPart.sparePartPlaceholder}</option>
                {spareParts.map((sp) => (
                  <option key={sp.id} value={sp.id}>{sp.code} — {sp.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{d.fPart.quantity}</label>
              <input name="quantity" type="number" step="0.01" min="0.01" required className={`${ui.input} w-24`} />
            </div>
            <div>
              <label className={ui.label}>{d.fPart.unitCost}</label>
              <input name="unitCost" type="number" step="0.01" className={`${ui.input} w-28`} />
            </div>
            <div>
              <label className={ui.label}>{d.fPart.serialNumber}</label>
              <input name="serialNumber" className={`${ui.input} w-40`} dir="ltr" />
            </div>
            <button className={ui.button}>{d.issuePart}</button>
          </form>
        )}
      </div>

      {completeFlag === "1" && (
        <Modal title={d.completeTitle} closeHref={baseUrl}>
          <form action={completeMaintenanceOrder} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={order.id} />
            <div>
              <label className={ui.label}>{d.f.resolutionNotes}</label>
              <textarea name="resolutionNotes" required rows={3} className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{d.f.laborCost}</label>
              <input name="laborCost" type="number" step="0.01" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{d.markComplete}</button>
          </form>
        </Modal>
      )}

      <Link href="/maintenance?tab=orders" className="text-sm font-medium text-accent-strong hover:underline">
        {d.back}
      </Link>
    </div>
  );
}
