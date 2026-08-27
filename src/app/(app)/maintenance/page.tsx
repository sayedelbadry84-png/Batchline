import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId, reservationSiteScopeWhere } from "@/lib/siteScope";
import { getEquipmentOptions } from "@/lib/equipmentRegistry";
import { Modal } from "@/components/Modal";
import { EquipmentPicker } from "@/components/EquipmentPicker";
import {
  createMaintenanceTicket,
  startMaintenanceTicket,
  completeMaintenanceTicket,
  cancelMaintenanceTicket,
  createMaintenancePlan,
  deactivateMaintenancePlan,
  generateTicketFromPlan,
} from "./actions";

const MAINTENANCE_TABS = ["tickets", "plans"] as const;
type MaintenanceTab = (typeof MAINTENANCE_TABS)[number];
const TICKET_TYPES = ["PREVENTIVE", "CORRECTIVE", "INSPECTION"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

const statusChip: Record<string, string> = {
  OPEN: "bg-warn-soft text-warn",
  IN_PROGRESS: "bg-accent-soft text-accent-strong",
  COMPLETED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};
const priorityChip: Record<string, string> = {
  LOW: "bg-surface-alt text-ink-muted",
  NORMAL: "bg-surface-alt text-ink-muted",
  HIGH: "bg-warn-soft text-warn",
  CRITICAL: "bg-critical-soft text-critical",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; new?: string; newPlan?: string; complete?: string }>;
}) {
  const user = await requirePageAccess("maintenance");
  const { dict } = await getDictionary();
  const m = dict.modules.maintenance;
  const { tab: tabRaw, new: newFlag, newPlan: newPlanFlag, complete: completeId } = await searchParams;
  const tab: MaintenanceTab = MAINTENANCE_TABS.includes(tabRaw as MaintenanceTab) ? (tabRaw as MaintenanceTab) : "tickets";
  const siteId = await getActiveSiteId(user);
  const siteScope = reservationSiteScopeWhere(siteId);

  const [sites, equipmentOptions, assignees] = await Promise.all([
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    getEquipmentOptions(siteId),
    prisma.user.findMany({ where: { role: { in: ["PLANT_OPERATOR", "PLANT_ADMIN", "OPERATIONS_SUPERVISOR", "ADMIN"] } }, orderBy: { name: "asc" } }),
  ]);

  const baseUrl = `/maintenance?tab=${tab}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {MAINTENANCE_TABS.map((t) => (
          <Link
            key={t}
            href={`/maintenance?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {m.tabs[t]}
          </Link>
        ))}
      </div>

      {tab === "tickets" && (
        <TicketsTab
          m={m}
          dict={dict}
          siteScope={siteScope}
          sites={sites}
          equipmentOptions={equipmentOptions}
          assignees={assignees}
          newFlag={newFlag}
          completeId={completeId}
          baseUrl={baseUrl}
        />
      )}

      {tab === "plans" && (
        <PlansTab m={m} dict={dict} siteScope={siteScope} sites={sites} equipmentOptions={equipmentOptions} newPlanFlag={newPlanFlag} baseUrl={baseUrl} />
      )}
    </div>
  );
}

async function TicketsTab({
  m,
  dict,
  siteScope,
  sites,
  equipmentOptions,
  assignees,
  newFlag,
  completeId,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["maintenance"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  equipmentOptions: { type: string; id: string; label: string }[];
  assignees: { id: string; name: string }[];
  newFlag?: string;
  completeId?: string;
  baseUrl: string;
}) {
  const tickets = await prisma.maintenanceTicket.findMany({
    where: siteScope,
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    include: { assignedTo: true, reportedBy: true },
  });

  const openCount = tickets.filter((t) => t.status === "OPEN").length;
  const inProgressCount = tickets.filter((t) => t.status === "IN_PROGRESS").length;
  const criticalOpenCount = tickets.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status) && t.priority === "CRITICAL").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4">
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{m.stats.open}</div>
          <div className="mt-1 font-mono text-2xl font-semibold">{openCount}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{m.stats.inProgress}</div>
          <div className="mt-1 font-mono text-2xl font-semibold">{inProgressCount}</div>
        </div>
        <div className={`${ui.card} ${criticalOpenCount > 0 ? "border-critical" : ""}`}>
          <div className="text-xs text-ink-muted">{m.stats.criticalOpen}</div>
          <div className={`mt-1 font-mono text-2xl font-semibold ${criticalOpenCount > 0 ? "text-critical" : ""}`}>{criticalOpenCount}</div>
        </div>
      </div>

      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&new=1`} className={ui.button}>+ {m.tickets.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.tickets.col.number}</th>
              <th className={ui.th}>{m.tickets.col.equipment}</th>
              <th className={ui.th}>{m.tickets.col.type}</th>
              <th className={ui.th}>{m.tickets.col.priority}</th>
              <th className={ui.th}>{m.tickets.col.status}</th>
              <th className={ui.th}>{m.tickets.col.scheduledFor}</th>
              <th className={ui.th}>{m.tickets.col.assignedTo}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id}>
                <td className={`${ui.td} font-mono text-xs`}>{t.ticketNumber}</td>
                <td className={ui.td}>{t.equipmentLabel}</td>
                <td className={ui.td}>{m.typeLabel[t.type as keyof typeof m.typeLabel] ?? t.type}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${priorityChip[t.priority] ?? ""}`}>{m.priorityLabel[t.priority as keyof typeof m.priorityLabel] ?? t.priority}</span>
                </td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{m.statusLabel[t.status as keyof typeof m.statusLabel] ?? t.status}</span>
                </td>
                <td className={ui.td}>{fmtDate(t.scheduledFor)}</td>
                <td className={ui.td}>{t.assignedTo?.name ?? "—"}</td>
                <td className={ui.td}>
                  <div className="flex flex-col gap-1">
                    {t.status === "OPEN" && (
                      <form action={startMaintenanceTicket}>
                        <input type="hidden" name="id" value={t.id} />
                        <button className="text-xs font-medium text-accent-strong hover:underline">{m.tickets.start}</button>
                      </form>
                    )}
                    {["OPEN", "IN_PROGRESS"].includes(t.status) && (
                      <Link href={`${baseUrl}&complete=${t.id}`} className="text-xs font-medium text-good hover:underline">{m.tickets.complete}</Link>
                    )}
                    {["OPEN", "IN_PROGRESS"].includes(t.status) && (
                      <form action={cancelMaintenanceTicket}>
                        <input type="hidden" name="id" value={t.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{m.tickets.cancel}</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {tickets.length === 0 && (
              <tr><td className={ui.td} colSpan={8}><span className="text-ink-muted">{m.tickets.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newFlag === "1" && (
        <Modal title={m.tickets.newTitle} closeHref={baseUrl}>
          <form action={createMaintenanceTicket} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.tickets.f.equipment}</label>
              <EquipmentPicker options={equipmentOptions} placeholder={m.tickets.f.equipmentPlaceholder} typeLabels={m.equipmentTypeLabel} />
            </div>
            <div>
              <label className={ui.label}>{m.tickets.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.tickets.f.type}</label>
                <select name="type" required className={ui.select}>
                  {TICKET_TYPES.map((t) => (
                    <option key={t} value={t}>{m.typeLabel[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.tickets.f.priority}</label>
                <select name="priority" defaultValue="NORMAL" className={ui.select}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>{m.priorityLabel[p]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.tickets.f.faultDescription}</label>
              <textarea name="faultDescription" rows={3} className={ui.input} />
              <p className="mt-1 text-xs text-ink-muted">{m.tickets.faultRequiredHint}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.tickets.f.scheduledFor}</label>
                <input name="scheduledFor" type="date" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.tickets.f.assignedToId}</label>
                <select name="assignedToId" defaultValue="" className={ui.select}>
                  <option value="">{dict.field.none}</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.tickets.add}</button>
          </form>
        </Modal>
      )}

      {completeId && (
        <Modal title={m.tickets.completeTitle} closeHref={baseUrl}>
          <form action={completeMaintenanceTicket} className="flex flex-col gap-3">
            <input type="hidden" name="id" value={completeId} />
            <div>
              <label className={ui.label}>{m.tickets.f.resolutionNotes}</label>
              <textarea name="resolutionNotes" required rows={3} className={ui.input} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={ui.label}>{m.tickets.f.laborCost}</label>
                <input name="laborCost" type="number" step="0.01" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.tickets.f.partsCost}</label>
                <input name="partsCost" type="number" step="0.01" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.tickets.f.downtimeHours}</label>
                <input name="downtimeHours" type="number" step="0.1" className={ui.input} />
              </div>
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.tickets.markComplete}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function PlansTab({
  m,
  dict,
  siteScope,
  sites,
  equipmentOptions,
  newPlanFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["maintenance"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  equipmentOptions: { type: string; id: string; label: string }[];
  newPlanFlag?: string;
  baseUrl: string;
}) {
  const plans = await prisma.maintenancePlan.findMany({
    where: { ...siteScope, active: true },
    orderBy: [{ nextDueAt: "asc" }],
  });
  const now = new Date();

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newPlan=1`} className={ui.button}>+ {m.plans.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.plans.col.equipment}</th>
              <th className={ui.th}>{m.plans.col.interval}</th>
              <th className={ui.th}>{m.plans.col.lastCompleted}</th>
              <th className={ui.th}>{m.plans.col.nextDue}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const overdue = p.nextDueAt != null && p.nextDueAt <= now;
              return (
                <tr key={p.id}>
                  <td className={ui.td}>{p.equipmentLabel}</td>
                  <td className={ui.td}>
                    {p.intervalDays ? m.plans.everyDays(p.intervalDays) : ""}
                    {p.intervalDays && p.intervalTrips ? " / " : ""}
                    {p.intervalTrips ? m.plans.everyTrips(p.intervalTrips) : ""}
                  </td>
                  <td className={ui.td}>{fmtDate(p.lastCompletedAt)}</td>
                  <td className={ui.td}>
                    <span className={overdue ? "font-medium text-critical" : ""}>
                      {fmtDate(p.nextDueAt)}
                      {overdue && <span className={`${ui.chip} ms-2 bg-critical-soft text-critical`}>{m.plans.overdueBadge}</span>}
                    </span>
                  </td>
                  <td className={ui.td}>
                    <div className="flex flex-col gap-1">
                      <form action={generateTicketFromPlan}>
                        <input type="hidden" name="planId" value={p.id} />
                        <button className="text-xs font-medium text-accent-strong hover:underline">{m.plans.generateTicket}</button>
                      </form>
                      <form action={deactivateMaintenancePlan}>
                        <input type="hidden" name="id" value={p.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{m.plans.deactivate}</button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
            {plans.length === 0 && (
              <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.plans.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newPlanFlag === "1" && (
        <Modal title={m.plans.newTitle} closeHref={baseUrl}>
          <form action={createMaintenancePlan} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.tickets.f.equipment}</label>
              <EquipmentPicker options={equipmentOptions} placeholder={m.tickets.f.equipmentPlaceholder} typeLabels={m.equipmentTypeLabel} />
            </div>
            <div>
              <label className={ui.label}>{m.tickets.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.plans.f.intervalDays}</label>
                <input name="intervalDays" type="number" step="1" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.plans.f.intervalTrips}</label>
                <input name="intervalTrips" type="number" step="1" className={ui.input} />
              </div>
            </div>
            <p className="text-xs text-ink-muted">{m.plans.intervalHint}</p>
            <div>
              <label className={ui.label}>{m.plans.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.plans.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
