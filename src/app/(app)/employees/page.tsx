import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createEmployee, updateEmployee, createPumpCrewMember, updatePumpCrewMember, createJobTitle } from "./actions";

const ADMIN_ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "DISPATCHER", "ADMIN"] as const;
const EMPLOYEE_STATUSES = ["ACTIVE", "FROZEN", "REMOVED"] as const;

// One entry per tab: which model backs it, how its rows are filtered, and
// (for the employee-backed tabs) whether the role is fixed by the tab
// itself or picked from a list — a person only shows up in the tab their
// role already puts them in, so a fixed-role tab's create/edit form never
// asks for a role at all.
const TAB_KEYS = ["mixerDriver", "pumpOperator", "pumpAssistant", "bulkerDriver", "waterDriver", "loaderDriver", "admin"] as const;
type TabKey = (typeof TAB_KEYS)[number];

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
  searchParams: Promise<{ tab?: string; edit?: string }>;
}) {
  await requirePageAccess("employees");
  const { dict } = await getDictionary();
  const m = dict.modules.employees;
  const { tab: tabRaw, edit: editId } = await searchParams;
  const tab: TabKey = (TAB_KEYS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as TabKey) : "mixerDriver";
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const isCrewTab = tab === "pumpOperator" || tab === "pumpAssistant";
  const fixedRole = EMPLOYEE_TAB_ROLE[tab];

  const plants = await prisma.plant.findMany({ orderBy: { name: "asc" } });
  const jobTitles = await prisma.jobTitle.findMany({ orderBy: { name: "asc" } });
  // Built-in roles plus whatever an Admin has added from this screen —
  // deduped since a custom title could in principle repeat a built-in name.
  const roleOptions = Array.from(new Set([...ADMIN_ROLES, ...jobTitles.map((j) => j.name)]));

  const employees = !isCrewTab
    ? await prisma.employee.findMany({
        where: { role: fixedRole ?? { in: [...ADMIN_ROLES] } },
        orderBy: { createdAt: "asc" },
        include: { plant: true },
      })
    : [];

  const crew = isCrewTab
    ? await prisma.pumpCrewMember.findMany({
        where: { role: CREW_TAB_ROLE[tab] },
        orderBy: { name: "asc" },
        include: { plant: true },
      })
    : [];

  const tabs: { key: TabKey; label: string }[] = [
    { key: "mixerDriver", label: m.tabs.mixerDriver },
    { key: "pumpOperator", label: m.tabs.pumpOperator },
    { key: "pumpAssistant", label: m.tabs.pumpAssistant },
    { key: "bulkerDriver", label: m.tabs.bulkerDriver },
    { key: "waterDriver", label: m.tabs.waterDriver },
    { key: "loaderDriver", label: m.tabs.loaderDriver },
    { key: "admin", label: m.tabs.admin },
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
                  <th className={ui.th}>{dict.field.plant}</th>
                  <th className={ui.th}>{m.crewCol.phone}</th>
                  <th className={ui.th}>{m.crewCol.status}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {crew.map((c) =>
                  editId === c.id ? (
                    <tr key={c.id}>
                      <td className={ui.td} colSpan={5}>
                        <form action={updatePumpCrewMember} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="role" value={CREW_TAB_ROLE[tab]} />
                          <div>
                            <label className={ui.label}>{dict.field.plant}</label>
                            <select name="plantId" defaultValue={c.plantId} required className={`${ui.select} w-36`}>
                              {plants.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.crewF.name}</label>
                            <input name="name" defaultValue={c.name} required className={`${ui.input} w-36`} />
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
                      <td className={ui.td}>{c.plant.name}</td>
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
                    <td className={ui.td} colSpan={5}>
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
              <label className={ui.label}>{dict.field.plant}</label>
              <select name="plantId" required className={ui.select}>
                <option value="">{dict.field.selectPlant}</option>
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.crewF.name}</label>
              <input name="name" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.crewF.phone}</label>
              <input name="phone" className={ui.input} dir="ltr" />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>
              {m.add}
            </button>
          </form>
        </div>
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
                              <label className={ui.label}>{dict.field.plant}</label>
                              <select name="plantId" defaultValue={e.plantId} required className={`${ui.select} w-36`}>
                                {plants.map((p) => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
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
                            {tab === "admin" && (
                              <div>
                                <label className={ui.label}>{m.f.role}</label>
                                <select name="role" defaultValue={e.role} required className={`${ui.select} w-40`}>
                                  {roleOptions.map((r) => (
                                    <option key={r} value={r}>{dict.roles[r as keyof typeof dict.roles] ?? r}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div>
                              <label className={ui.label}>{m.f.shiftPattern}</label>
                              <input name="shiftPattern" defaultValue={e.shiftPattern ?? ""} className={`${ui.input} w-32`} dir="ltr" />
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
                      <td className={ui.td}>{e.plant.name}</td>
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
              <label className={ui.label}>{dict.field.plant}</label>
              <select name="plantId" required className={ui.select}>
                <option value="">{dict.field.selectPlant}</option>
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
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
            {tab === "admin" && (
              <div>
                <label className={ui.label}>{m.f.role}</label>
                <select name="role" required className={ui.select}>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {dict.roles[r as keyof typeof dict.roles] ?? r}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className={ui.label}>{m.f.shiftPattern}</label>
              <input name="shiftPattern" className={ui.input} placeholder="Day / 6am–6pm" dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.licenseExpiry}</label>
              <input name="licenseExpiry" type="date" className={ui.input} />
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
