import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  createEmployee,
  updateEmployee,
  createPumpCrewMember,
  updatePumpCrewMember,
  createJobTitle,
  recordAttendance,
  createLeaveRequest,
  approveLeaveRequest,
  rejectLeaveRequest,
  cancelLeaveRequest,
  calculateEndOfServiceSettlement,
  cancelEndOfServiceSettlement,
  markEndOfServiceSettlementPaid,
} from "./actions";
import { generatePayrollRun } from "./payroll/actions";
import { getActiveSiteId, plantScopeWhere } from "@/lib/siteScope";
import { RoleSelect } from "@/components/RoleSelect";
import { TERMINATION_TYPES } from "@/lib/endOfService";

const ADMIN_ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "DISPATCHER", "ADMIN"] as const;
const EMPLOYEE_STATUSES = ["ACTIVE", "FROZEN", "REMOVED"] as const;
const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LATE", "HALF_DAY", "ON_LEAVE", "HOLIDAY"] as const;
const LEAVE_TYPES = ["ANNUAL", "SICK", "UNPAID", "EMERGENCY", "OTHER"] as const;

// One entry per tab: which model backs it, how its rows are filtered, and
// (for the employee-backed tabs) whether the role is fixed by the tab
// itself or picked from a list — a person only shows up in the tab their
// role already puts them in, so a fixed-role tab's create/edit form never
// asks for a role at all. "attendance"/"leave" are cross-role — every
// active employee regardless of which other tab they'd show up in — so
// they're rendered by their own branch below, same as isCrewTab already is.
const TAB_KEYS = ["mixerDriver", "pumpOperator", "pumpAssistant", "bulkerDriver", "waterDriver", "loaderDriver", "admin", "attendance", "leave", "payroll", "endOfService"] as const;
type TabKey = (typeof TAB_KEYS)[number];
const WAGE_TYPES = ["MONTHLY", "DAILY"] as const;

const EMPLOYEE_TAB_ROLE: Partial<Record<TabKey, string>> = {
  mixerDriver: "DRIVER",
  bulkerDriver: "BULKER_DRIVER",
  waterDriver: "WATER_TANKER_DRIVER",
  loaderDriver: "LOADER_DRIVER",
};
const CREW_TAB_ROLE: Partial<Record<TabKey, string>> = {
  pumpOperator: "OPERATOR",
  pumpAssistant: "HELPER",
};

// Pure and outside the component body on purpose — takes "now" and the
// translated labels as arguments instead of closing over Date.now()/dict,
// so it stays a plain, side-effect-free helper.
function expiryFlag(date: Date | null, nowMs: number, labels: { expired: string; daysLeft: (n: number) => string }) {
  if (!date) return null;
  const days = Math.ceil((date.getTime() - nowMs) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: labels.expired, cls: "bg-critical-soft text-critical" };
  if (days <= 30) return { label: labels.daysLeft(days), cls: "bg-warn-soft text-warn" };
  return null;
}

const statusChip: Record<string, string> = {
  ACTIVE: "bg-good-soft text-good",
  FROZEN: "bg-warn-soft text-warn",
  REMOVED: "bg-critical-soft text-critical",
};

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; edit?: string; date?: string; reject?: string }>;
}) {
  const user = await requirePageAccess("employees");
  const { dict } = await getDictionary();
  const m = dict.modules.employees;
  const { tab: tabRaw, edit: editId, date: dateRaw, reject: rejectId } = await searchParams;
  const tab: TabKey = (TAB_KEYS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as TabKey) : "mixerDriver";
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const siteId = await getActiveSiteId(user);

  const isCrewTab = tab === "pumpOperator" || tab === "pumpAssistant";
  const isAttendanceTab = tab === "attendance";
  const isLeaveTab = tab === "leave";
  const isPayrollTab = tab === "payroll";
  const isEndOfServiceTab = tab === "endOfService";
  const isHrTab = isAttendanceTab || isLeaveTab;
  const fixedRole = EMPLOYEE_TAB_ROLE[tab];
  const isDateParam = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const selectedDate = isDateParam(dateRaw) ? dateRaw : new Date().toISOString().slice(0, 10);

  // Registration picks a Site by its code, not a specific production line —
  // a person can work either line at a site interchangeably (both share
  // the same yard/stock). The form submits siteId; the action resolves it
  // down to a concrete Plant row (see resolvePlantIdForSite in siteScope.ts).
  // A site with no production line registered yet has nothing to resolve
  // to, so it's excluded here rather than offered and silently failing on
  // submit — it becomes selectable the moment its first line is added.
  const sitesForPicker = await prisma.site.findMany({
    where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
    orderBy: { code: "asc" },
  });
  const jobTitles = await prisma.jobTitle.findMany({ orderBy: { name: "asc" } });
  // Built-in roles plus whatever an Admin has added from this screen —
  // deduped since a custom title could in principle repeat a built-in name.
  const roleOptions = Array.from(new Set([...ADMIN_ROLES, ...jobTitles.map((j) => j.name)]));
  // A plain map, not a function — RoleSelect is a Client Component and
  // can't receive a function prop across the RSC boundary.
  const roleLabels = Object.fromEntries(roleOptions.map((r) => [r, dict.roles[r as keyof typeof dict.roles] ?? r]));

  // The admin tab has no fixedRole of its own — it's everyone NOT already
  // claimed by one of the other (driver) tabs, not just the built-in
  // ADMIN_ROLES list. A custom job title (built-in or picked via "Other"
  // on this same tab) belongs here too, or it would vanish from every
  // tab's listing the moment it's saved.
  const employees = !isCrewTab && !isHrTab && !isPayrollTab && !isEndOfServiceTab
    ? await prisma.employee.findMany({
        where: {
          role: fixedRole ?? { notIn: Object.values(EMPLOYEE_TAB_ROLE) },
          ...plantScopeWhere(siteId),
        },
        orderBy: { createdAt: "asc" },
        include: { plant: { include: { site: true } } },
      })
    : [];

  const crew = isCrewTab
    ? await prisma.pumpCrewMember.findMany({
        where: { role: CREW_TAB_ROLE[tab], ...plantScopeWhere(siteId) },
        orderBy: { name: "asc" },
        include: { plant: { include: { site: true } } },
      })
    : [];

  // Attendance/Leave are cross-role — every active employee at the caller's
  // scope, not just one tab's own role slice.
  const allActiveEmployees = isHrTab
    ? await prisma.employee.findMany({ where: { status: "ACTIVE", ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } })
    : [];

  const attendanceForDate = isAttendanceTab
    ? await prisma.attendanceRecord.findMany({ where: { date: new Date(`${selectedDate}T00:00:00`), employeeId: { in: allActiveEmployees.map((e) => e.id) } } })
    : [];
  const attendanceByEmployee = new Map(attendanceForDate.map((a) => [a.employeeId, a]));

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const [leaveRequests, approvedAnnualThisYear] = isLeaveTab
    ? await Promise.all([
        prisma.leaveRequest.findMany({
          where: { employeeId: { in: allActiveEmployees.map((e) => e.id) } },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { employee: true, requestedBy: true, approvedBy: true },
        }),
        prisma.leaveRequest.findMany({
          where: { employeeId: { in: allActiveEmployees.map((e) => e.id) }, type: "ANNUAL", status: "APPROVED", startDate: { gte: yearStart } },
          select: { employeeId: true, daysCount: true },
        }),
      ])
    : [[], []];
  const usedAnnualByEmployee = new Map<string, number>();
  for (const l of approvedAnnualThisYear) {
    usedAnnualByEmployee.set(l.employeeId, (usedAnnualByEmployee.get(l.employeeId) ?? 0) + l.daysCount);
  }

  // Payroll touches salary data, so its tab is only offered to full Admins —
  // everyone else keeps seeing the rest of the module unchanged. The real
  // boundary is still the requireRole(["ADMIN"]) check inside every payroll
  // action (payroll/actions.ts); hiding the tab is just so a non-admin never
  // lands on a screen of buttons that would throw.
  const isAdmin = user.role === "ADMIN";

  const payrollRuns = isPayrollTab
    ? await prisma.payrollRun.findMany({
        orderBy: { createdAt: "desc" },
        include: { lines: { select: { netPay: true } } },
      })
    : [];

  // Same Admin-only boundary as payroll — a gratuity figure is salary data
  // too. Only employees with what the formula actually needs on file
  // (hire date, wage type/rate) are offered in the picker, so the form
  // can't be submitted for someone the calculation would just refuse.
  const [endOfServiceSettlements, eosEligibleEmployees] = isEndOfServiceTab
    ? await Promise.all([
        prisma.endOfServiceSettlement.findMany({
          orderBy: { createdAt: "desc" },
          include: { employee: true },
        }),
        prisma.employee.findMany({
          where: { status: "ACTIVE", hireDate: { not: null }, wageRate: { not: null }, wageType: { not: null }, ...plantScopeWhere(siteId) },
          orderBy: { name: "asc" },
        }),
      ])
    : [[], []];

  const tabs: { key: TabKey; label: string }[] = [
    { key: "mixerDriver", label: m.tabs.mixerDriver },
    { key: "pumpOperator", label: m.tabs.pumpOperator },
    { key: "pumpAssistant", label: m.tabs.pumpAssistant },
    { key: "bulkerDriver", label: m.tabs.bulkerDriver },
    { key: "waterDriver", label: m.tabs.waterDriver },
    { key: "loaderDriver", label: m.tabs.loaderDriver },
    { key: "admin", label: m.tabs.admin },
    { key: "attendance", label: m.tabs.attendance },
    { key: "leave", label: m.tabs.leave },
    ...(isAdmin ? [{ key: "payroll" as TabKey, label: m.tabs.payroll }] : []),
    ...(isAdmin ? [{ key: "endOfService" as TabKey, label: m.tabs.endOfService }] : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/employees?tab=${t.key}`}
            className={`rounded-t-md px-3 py-2 text-sm ${
              tab === t.key
                ? "border-b-2 border-accent font-medium text-ink"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {isCrewTab ? (
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.crewCol.name}</th>
                  <th className={ui.th}>{m.crewCol.code}</th>
                  <th className={ui.th}>{dict.field.siteCode}</th>
                  <th className={ui.th}>{m.crewCol.phone}</th>
                  <th className={ui.th}>{m.crewCol.status}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {crew.map((c) =>
                  editId === c.id ? (
                    <tr key={c.id}>
                      <td className={ui.td} colSpan={6}>
                        <form action={updatePumpCrewMember} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="role" value={CREW_TAB_ROLE[tab]} />
                          <div>
                            <label className={ui.label}>{dict.field.siteCode}</label>
                            <select name="siteId" defaultValue={c.plant.siteId} required className={`${ui.select} w-36`}>
                              {sitesForPicker.map((s) => (
                                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.crewF.name}</label>
                            <input name="name" defaultValue={c.name} required className={`${ui.input} w-36`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.crewF.code}</label>
                            <input name="code" defaultValue={c.code ?? ""} className={`${ui.input} w-24`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.crewF.phone}</label>
                            <input name="phone" defaultValue={c.phone ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.crewCol.status}</label>
                            <select name="status" defaultValue={c.status} className={`${ui.select} w-28`}>
                              {EMPLOYEE_STATUSES.map((s) => (
                                <option key={s} value={s}>{dict.status[s]}</option>
                              ))}
                            </select>
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href={`/employees?tab=${tab}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td className={`${ui.td} font-medium`}>{c.name}</td>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{c.code || "—"}</td>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{c.plant.site.code}</td>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{c.phone || "—"}</td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} ${statusChip[c.status] ?? statusChip.ACTIVE}`}>
                          {dict.status[c.status as keyof typeof dict.status] ?? c.status}
                        </span>
                      </td>
                      <td className={ui.td}>
                        <Link href={`/employees?tab=${tab}&edit=${c.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      </td>
                    </tr>
                  )
                )}
                {crew.length === 0 && (
                  <tr>
                    <td className={ui.td} colSpan={6}>
                      <span className="text-ink-muted">{m.crewEmpty}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <form action={createPumpCrewMember} className={`${ui.card} flex flex-col gap-3`}>
            <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
            <input type="hidden" name="role" value={CREW_TAB_ROLE[tab]} />
            <div>
              <label className={ui.label}>{dict.field.siteCode}</label>
              <select name="siteId" required className={ui.select}>
                <option value="">{dict.field.selectSite}</option>
                {sitesForPicker.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.crewF.name}</label>
              <input name="name" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.crewF.code}</label>
              <input name="code" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.crewF.phone}</label>
              <input name="phone" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.crewF.loginEmail}</label>
              <input name="loginEmail" type="email" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.crewF.loginPassword}</label>
              <input name="loginPassword" type="password" minLength={8} className={ui.input} dir="ltr" />
            </div>
            <p className="text-xs text-ink-muted">{m.loginAccountHint}</p>
            <button type="submit" className={`${ui.button} mt-2`}>
              {m.add}
            </button>
          </form>
        </div>
      ) : isAttendanceTab ? (
        <div className="flex flex-col gap-4">
          <form action="/employees" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tab" value="attendance" />
            <div>
              <label className={ui.label}>{m.attendance.date}</label>
              <input type="date" name="date" defaultValue={selectedDate} className={`${ui.input} w-40`} />
            </div>
            <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{m.attendance.applyDate}</button>
          </form>

          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.col.name}</th>
                  <th className={ui.th}>{m.col.role}</th>
                  <th className={ui.th}>{m.attendance.col.status}</th>
                  <th className={ui.th}>{m.attendance.col.checkIn}</th>
                  <th className={ui.th}>{m.attendance.col.checkOut}</th>
                  <th className={ui.th}>{m.attendance.col.notes}</th>
                  <th className={ui.th}></th>
                </tr>
              </thead>
              <tbody>
                {allActiveEmployees.map((e) => {
                  const record = attendanceByEmployee.get(e.id);
                  return (
                    <tr key={e.id}>
                      <td className={`${ui.td} font-medium`}>{e.name}</td>
                      <td className={`${ui.td} font-mono text-xs`}>{dict.roles[e.role as keyof typeof dict.roles] ?? e.role}</td>
                      <td className={ui.td} colSpan={5}>
                        <form action={recordAttendance} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="employeeId" value={e.id} />
                          <input type="hidden" name="date" value={selectedDate} />
                          <select name="status" defaultValue={record?.status ?? "PRESENT"} className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                            {ATTENDANCE_STATUSES.map((s) => (
                              <option key={s} value={s}>{m.attendance.statusLabel[s]}</option>
                            ))}
                          </select>
                          <input
                            type="time"
                            name="checkInAt"
                            defaultValue={record?.checkInAt ? new Date(record.checkInAt).toTimeString().slice(0, 5) : ""}
                            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                          />
                          <input
                            type="time"
                            name="checkOutAt"
                            defaultValue={record?.checkOutAt ? new Date(record.checkOutAt).toTimeString().slice(0, 5) : ""}
                            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                          />
                          <input name="notes" defaultValue={record?.notes ?? ""} placeholder={m.attendance.col.notes} className="w-32 rounded-md border border-border bg-surface px-2 py-1 text-xs" />
                          <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{dict.field.save}</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
                {allActiveEmployees.length === 0 && (
                  <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.attendance.empty}</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : isLeaveTab ? (
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className="flex flex-col gap-6">
            <div className={ui.card}>
              <h2 className="mb-3 font-display text-lg font-semibold">{m.leave.balanceTitle}</h2>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.col.name}</th>
                    <th className={ui.th}>{m.leave.col.entitlement}</th>
                    <th className={ui.th}>{m.leave.col.used}</th>
                    <th className={ui.th}>{m.leave.col.remaining}</th>
                  </tr>
                </thead>
                <tbody>
                  {allActiveEmployees.map((e) => {
                    const used = usedAnnualByEmployee.get(e.id) ?? 0;
                    return (
                      <tr key={e.id}>
                        <td className={`${ui.td} font-medium`}>{e.name}</td>
                        <td className={`${ui.td} font-mono`}>{e.annualLeaveEntitlementDays}</td>
                        <td className={`${ui.td} font-mono`}>{used}</td>
                        <td className={`${ui.td} font-mono`}>{e.annualLeaveEntitlementDays - used}</td>
                      </tr>
                    );
                  })}
                  {allActiveEmployees.length === 0 && (
                    <tr><td className={ui.td} colSpan={4}><span className="text-ink-muted">{m.attendance.empty}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className={ui.card}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.leave.col.number}</th>
                    <th className={ui.th}>{m.col.name}</th>
                    <th className={ui.th}>{m.leave.col.type}</th>
                    <th className={ui.th}>{m.leave.col.dates}</th>
                    <th className={ui.th}>{m.leave.col.days}</th>
                    <th className={ui.th}>{m.leave.col.status}</th>
                    <th className={ui.th}>{dict.field.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {leaveRequests.map((l) => (
                    <tr key={l.id}>
                      <td className={`${ui.td} font-mono text-xs`}>{l.requestNumber}</td>
                      <td className={ui.td}>{l.employee.name}</td>
                      <td className={ui.td}>{m.leave.typeLabel[l.type as keyof typeof m.leave.typeLabel] ?? l.type}</td>
                      <td className={ui.td}>{new Date(l.startDate).toLocaleDateString("en-GB")} — {new Date(l.endDate).toLocaleDateString("en-GB")}</td>
                      <td className={`${ui.td} font-mono`}>{l.daysCount}</td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} ${l.status === "APPROVED" ? "bg-good-soft text-good" : l.status === "REJECTED" || l.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"}`}>
                          {m.leave.statusLabel[l.status as keyof typeof m.leave.statusLabel] ?? l.status}
                        </span>
                        {l.rejectionNote && <div className="mt-1 text-xs text-ink-muted">{l.rejectionNote}</div>}
                      </td>
                      <td className={ui.td}>
                        {l.status === "PENDING" && (
                          <div className="flex flex-col gap-1">
                            <form action={approveLeaveRequest}>
                              <input type="hidden" name="id" value={l.id} />
                              <button className="text-xs font-medium text-good hover:underline">{m.leave.approve}</button>
                            </form>
                            <Link href={`/employees?tab=leave&reject=${l.id}`} className="text-xs font-medium text-critical hover:underline">{m.leave.reject}</Link>
                            <form action={cancelLeaveRequest}>
                              <input type="hidden" name="id" value={l.id} />
                              <button className="text-xs font-medium text-ink-muted hover:underline">{m.leave.cancel}</button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {leaveRequests.length === 0 && (
                    <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.leave.empty}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <form action={createLeaveRequest} className={`${ui.card} flex flex-col gap-3`}>
              <h2 className="font-display text-lg font-semibold">{m.leave.newTitle}</h2>
              <div>
                <label className={ui.label}>{m.leave.f.employeeId}</label>
                <select name="employeeId" required className={ui.select}>
                  <option value="" disabled>{m.leave.f.employeePlaceholder}</option>
                  {allActiveEmployees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.leave.f.type}</label>
                <select name="type" required className={ui.select}>
                  {LEAVE_TYPES.map((t) => (
                    <option key={t} value={t}>{m.leave.typeLabel[t]}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={ui.label}>{m.leave.f.startDate}</label>
                  <input name="startDate" type="date" required className={ui.input} />
                </div>
                <div>
                  <label className={ui.label}>{m.leave.f.endDate}</label>
                  <input name="endDate" type="date" required className={ui.input} />
                </div>
              </div>
              <div>
                <label className={ui.label}>{m.leave.f.reason}</label>
                <input name="reason" className={ui.input} />
              </div>
              <button type="submit" className={`${ui.button} mt-2`}>{m.leave.add}</button>
            </form>

            {rejectId && (
              <form action={rejectLeaveRequest} className={`${ui.card} flex flex-col gap-3`}>
                <h2 className="font-display text-lg font-semibold">{m.leave.rejectTitle}</h2>
                <input type="hidden" name="id" value={rejectId} />
                <div>
                  <label className={ui.label}>{m.leave.f.rejectionNote}</label>
                  <textarea name="rejectionNote" required rows={3} className={ui.input} />
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={ui.button}>{m.leave.confirmReject}</button>
                  <Link href="/employees?tab=leave" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{dict.field.cancel}</Link>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : isPayrollTab ? (
        isAdmin ? (
          <div className="grid grid-cols-[1fr_320px] gap-6">
            <div className={ui.card}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.payroll.col.number}</th>
                    <th className={ui.th}>{m.payroll.col.period}</th>
                    <th className={ui.th}>{m.payroll.col.status}</th>
                    <th className={ui.th}>{m.payroll.col.total}</th>
                    <th className={ui.th}>{dict.field.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollRuns.map((r) => {
                    const total = r.lines.reduce((sum, l) => sum + l.netPay, 0);
                    return (
                      <tr key={r.id}>
                        <td className={`${ui.td} font-mono text-xs`}>{r.runNumber}</td>
                        <td className={ui.td}>
                          {new Date(r.periodStart).toLocaleDateString("en-GB")} — {new Date(r.periodEnd).toLocaleDateString("en-GB")}
                        </td>
                        <td className={ui.td}>
                          <span className={`${ui.chip} ${r.status === "PAID" ? "bg-good-soft text-good" : r.status === "APPROVED" ? "bg-accent-soft text-accent-strong" : r.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                            {m.payroll.statusLabel[r.status as keyof typeof m.payroll.statusLabel] ?? r.status}
                          </span>
                        </td>
                        <td className={`${ui.td} font-mono tabular`} dir="ltr">{total.toLocaleString()}</td>
                        <td className={ui.td}>
                          <Link href={`/employees/payroll/${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                            {m.payroll.view}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {payrollRuns.length === 0 && (
                    <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.payroll.empty}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <form action={generatePayrollRun} className={`${ui.card} flex flex-col gap-3`}>
              <h2 className="font-display text-lg font-semibold">{m.payroll.newTitle}</h2>
              <div>
                <label className={ui.label}>{m.payroll.f.periodStart}</label>
                <input name="periodStart" type="date" required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.payroll.f.periodEnd}</label>
                <input name="periodEnd" type="date" required className={ui.input} />
              </div>
              <p className="text-xs text-ink-muted">{m.payroll.newHint}</p>
              <button type="submit" className={`${ui.button} mt-2`}>{m.payroll.generate}</button>
            </form>
          </div>
        ) : null
      ) : isEndOfServiceTab ? (
        isAdmin ? (
          <div className="grid grid-cols-[1fr_320px] gap-6">
            <div className={ui.card}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.eos.col.number}</th>
                    <th className={ui.th}>{m.col.name}</th>
                    <th className={ui.th}>{m.eos.col.terminationDate}</th>
                    <th className={ui.th}>{m.eos.col.terminationType}</th>
                    <th className={ui.th}>{m.eos.col.years}</th>
                    <th className={ui.th}>{m.eos.col.payable}</th>
                    <th className={ui.th}>{m.eos.col.status}</th>
                    <th className={ui.th}>{dict.field.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {endOfServiceSettlements.map((s) => (
                    <tr key={s.id}>
                      <td className={`${ui.td} font-mono text-xs`}>{s.settlementNumber}</td>
                      <td className={`${ui.td} font-medium`}>{s.employee.name}</td>
                      <td className={ui.td}>{new Date(s.terminationDate).toLocaleDateString("en-GB")}</td>
                      <td className={ui.td}>{m.eos.typeLabel[s.terminationType as keyof typeof m.eos.typeLabel] ?? s.terminationType}</td>
                      <td className={`${ui.td} font-mono tabular`}>{s.yearsOfService.toFixed(1)}</td>
                      <td className={`${ui.td} font-mono tabular`} dir="ltr">{s.payableAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} ${s.status === "PAID" ? "bg-good-soft text-good" : s.status === "CANCELLED" ? "bg-critical-soft text-critical" : "bg-surface-alt text-ink-muted"}`}>
                          {m.eos.statusLabel[s.status as keyof typeof m.eos.statusLabel] ?? s.status}
                        </span>
                      </td>
                      <td className={ui.td}>
                        {s.status === "CALCULATED" && (
                          <div className="flex flex-col gap-1">
                            <form action={markEndOfServiceSettlementPaid}>
                              <input type="hidden" name="id" value={s.id} />
                              <button className="text-xs font-medium text-good hover:underline">{m.eos.markPaid}</button>
                            </form>
                            <form action={cancelEndOfServiceSettlement}>
                              <input type="hidden" name="id" value={s.id} />
                              <button className="text-xs font-medium text-critical hover:underline">{dict.field.cancel}</button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {endOfServiceSettlements.length === 0 && (
                    <tr><td className={ui.td} colSpan={8}><span className="text-ink-muted">{m.eos.empty}</span></td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <form action={calculateEndOfServiceSettlement} className={`${ui.card} flex flex-col gap-3`}>
              <h2 className="font-display text-lg font-semibold">{m.eos.newTitle}</h2>
              <div>
                <label className={ui.label}>{m.eos.f.employeeId}</label>
                <select name="employeeId" required className={ui.select}>
                  <option value="" disabled>{m.eos.f.employeePlaceholder}</option>
                  {eosEligibleEmployees.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>
              {eosEligibleEmployees.length === 0 && <p className="text-xs text-ink-muted">{m.eos.noEligible}</p>}
              <div>
                <label className={ui.label}>{m.eos.f.terminationDate}</label>
                <input name="terminationDate" type="date" required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.eos.f.terminationType}</label>
                <select name="terminationType" required className={ui.select}>
                  {TERMINATION_TYPES.map((t) => (
                    <option key={t} value={t}>{m.eos.typeLabel[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.eos.f.notes}</label>
                <input name="notes" className={ui.input} />
              </div>
              <p className="text-xs text-ink-muted">{m.eos.calcHint}</p>
              <button type="submit" className={`${ui.button} mt-2`}>{m.eos.calculate}</button>
            </form>
          </div>
        ) : null
      ) : (
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.col.name}</th>
                  <th className={ui.th}>{m.col.code}</th>
                  {tab === "admin" && <th className={ui.th}>{m.col.role}</th>}
                  <th className={ui.th}>{m.col.plant}</th>
                  <th className={ui.th}>{m.col.shift}</th>
                  <th className={ui.th}>{m.col.license}</th>
                  <th className={ui.th}>{m.col.status}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const flag = expiryFlag(e.licenseExpiry, nowMs, m);
                  const colCount = tab === "admin" ? 8 : 7;
                  if (editId === e.id) {
                    return (
                      <tr key={e.id}>
                        <td className={ui.td} colSpan={colCount}>
                          <form action={updateEmployee} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="id" value={e.id} />
                            {fixedRole && <input type="hidden" name="role" value={fixedRole} />}
                            <div>
                              <label className={ui.label}>{dict.field.siteCode}</label>
                              <select name="siteId" defaultValue={e.plant.siteId} required className={`${ui.select} w-36`}>
                                {sitesForPicker.map((s) => (
                                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.name}</label>
                              <input name="name" defaultValue={e.name} required className={`${ui.input} w-40`} />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.code}</label>
                              <input name="code" defaultValue={e.code ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.nationalId}</label>
                              <input name="nationalId" defaultValue={e.nationalId ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.iban}</label>
                              <input name="iban" defaultValue={e.iban ?? ""} className={`${ui.input} w-48`} dir="ltr" placeholder="SA__ ____ ____ ____ ____ ____" />
                            </div>
                            {tab === "admin" && (
                              <div>
                                <label className={ui.label}>{m.f.role}</label>
                                <RoleSelect
                                  roleOptions={roleOptions}
                                  roleLabels={roleLabels}
                                  defaultValue={e.role}
                                  otherLabel={m.otherRole}
                                  newRoleNamePlaceholder={m.newRoleNamePlaceholder}
                                  className={`${ui.select} w-40`}
                                />
                              </div>
                            )}
                            <div>
                              <label className={ui.label}>{m.f.shiftPattern}</label>
                              <input name="shiftPattern" defaultValue={e.shiftPattern ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.hireDate}</label>
                              <input
                                name="hireDate"
                                type="date"
                                defaultValue={e.hireDate ? new Date(e.hireDate).toISOString().slice(0, 10) : ""}
                                className={`${ui.input} w-40`}
                              />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.licenseExpiry}</label>
                              <input
                                name="licenseExpiry"
                                type="date"
                                defaultValue={e.licenseExpiry ? new Date(e.licenseExpiry).toISOString().slice(0, 10) : ""}
                                className={`${ui.input} w-40`}
                              />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.status}</label>
                              <select name="status" defaultValue={e.status} className={`${ui.select} w-28`}>
                                {EMPLOYEE_STATUSES.map((s) => (
                                  <option key={s} value={s}>{dict.status[s]}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.wageType}</label>
                              <select name="wageType" defaultValue={e.wageType ?? ""} className={`${ui.select} w-28`}>
                                <option value="">—</option>
                                {WAGE_TYPES.map((w) => (
                                  <option key={w} value={w}>{m.payroll.wageTypeLabel[w]}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.wageRate}</label>
                              <input name="wageRate" type="number" step="0.01" defaultValue={e.wageRate ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.isSaudiNational}</label>
                              <select name="isSaudiNational" defaultValue={String(e.isSaudiNational)} className={`${ui.select} w-28`}>
                                <option value="true">{m.f.saudiYes}</option>
                                <option value="false">{m.f.saudiNo}</option>
                              </select>
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.employeeGosiRatePct}</label>
                              <input name="employeeGosiRatePct" type="number" step="0.01" defaultValue={e.employeeGosiRatePct ?? ""} className={`${ui.input} w-24`} dir="ltr" placeholder={m.f.gosiDefaultPlaceholder} />
                            </div>
                            <div>
                              <label className={ui.label}>{m.f.employerGosiRatePct}</label>
                              <input name="employerGosiRatePct" type="number" step="0.01" defaultValue={e.employerGosiRatePct ?? ""} className={`${ui.input} w-24`} dir="ltr" placeholder={m.f.gosiDefaultPlaceholder} />
                            </div>
                            <button className={ui.button}>{dict.field.save}</button>
                            <Link href={`/employees?tab=${tab}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                              {dict.field.cancel}
                            </Link>
                          </form>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={e.id}>
                      <td className={`${ui.td} font-medium`}>{e.name}</td>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{e.code || "—"}</td>
                      {tab === "admin" && (
                        <td className={`${ui.td} font-mono text-xs`}>{dict.roles[e.role as keyof typeof dict.roles] ?? e.role}</td>
                      )}
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{e.plant.site.code}</td>
                      <td className={ui.td}>{e.shiftPattern || "—"}</td>
                      <td className={ui.td}>
                        {e.licenseExpiry ? new Date(e.licenseExpiry).toLocaleDateString() : "—"}
                        {flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>}
                      </td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} ${statusChip[e.status] ?? statusChip.ACTIVE}`}>
                          {dict.status[e.status as keyof typeof dict.status] ?? e.status}
                        </span>
                      </td>
                      <td className={ui.td}>
                        <Link href={`/employees?tab=${tab}&edit=${e.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {employees.length === 0 && (
                  <tr>
                    <td className={ui.td} colSpan={tab === "admin" ? 8 : 7}>
                      <span className="text-ink-muted">{m.empty}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-6">
          <form action={createEmployee} className={`${ui.card} flex flex-col gap-3`}>
            <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
            {fixedRole && <input type="hidden" name="role" value={fixedRole} />}
            <div>
              <label className={ui.label}>{dict.field.siteCode}</label>
              <select name="siteId" required className={ui.select}>
                <option value="">{dict.field.selectSite}</option>
                {sitesForPicker.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.name}</label>
              <input name="name" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.f.code}</label>
              <input name="code" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.nationalId}</label>
              <input name="nationalId" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.iban}</label>
              <input name="iban" className={ui.input} dir="ltr" placeholder="SA__ ____ ____ ____ ____ ____" />
              <p className="mt-1 text-xs text-ink-muted">{m.f.wpsHint}</p>
            </div>
            {tab === "mixerDriver" && (
              <>
                <div>
                  <label className={ui.label}>{m.f.loginEmail}</label>
                  <input name="loginEmail" type="email" className={ui.input} dir="ltr" />
                </div>
                <div>
                  <label className={ui.label}>{m.f.loginPassword}</label>
                  <input name="loginPassword" type="password" minLength={8} className={ui.input} dir="ltr" />
                </div>
                <p className="text-xs text-ink-muted">{m.loginAccountHint}</p>
              </>
            )}
            {tab === "admin" && (
              <div>
                <label className={ui.label}>{m.f.role}</label>
                <RoleSelect
                  roleOptions={roleOptions}
                  roleLabels={roleLabels}
                  otherLabel={m.otherRole}
                  newRoleNamePlaceholder={m.newRoleNamePlaceholder}
                />
              </div>
            )}
            <div>
              <label className={ui.label}>{m.f.shiftPattern}</label>
              <input name="shiftPattern" className={ui.input} placeholder="Day / 6am–6pm" dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.hireDate}</label>
              <input name="hireDate" type="date" className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.f.licenseExpiry}</label>
              <input name="licenseExpiry" type="date" className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.f.wageType}</label>
              <select name="wageType" defaultValue="" className={ui.select}>
                <option value="">—</option>
                {WAGE_TYPES.map((w) => (
                  <option key={w} value={w}>{m.payroll.wageTypeLabel[w]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.wageRate}</label>
              <input name="wageRate" type="number" step="0.01" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.isSaudiNational}</label>
              <select name="isSaudiNational" defaultValue="true" className={ui.select}>
                <option value="true">{m.f.saudiYes}</option>
                <option value="false">{m.f.saudiNo}</option>
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.employeeGosiRatePct}</label>
              <input name="employeeGosiRatePct" type="number" step="0.01" className={ui.input} dir="ltr" placeholder={m.f.gosiDefaultPlaceholder} />
            </div>
            <div>
              <label className={ui.label}>{m.f.employerGosiRatePct}</label>
              <input name="employerGosiRatePct" type="number" step="0.01" className={ui.input} dir="ltr" placeholder={m.f.gosiDefaultPlaceholder} />
              <p className="mt-1 text-xs text-ink-muted">{m.f.gosiHint}</p>
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>
              {m.add}
            </button>
          </form>

          {tab === "admin" && (
            <form action={createJobTitle} className={`${ui.card} flex flex-col gap-3`}>
              <h2 className="font-display text-lg font-semibold">{m.newJobTitle}</h2>
              <div>
                <label className={ui.label}>{m.f.jobTitleName}</label>
                <input name="name" required className={ui.input} />
              </div>
              <button type="submit" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                {m.addJobTitle}
              </button>
            </form>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
