import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createUser, updateUser, resetUserPassword } from "./actions";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; resetPassword?: string }>;
}) {
  // Deliberately not requirePageAccess/MODULE_ROLES — same reasoning as
  // /permissions: an account roster is a system-admin concern, never a
  // database-editable grant another role could end up with by accident.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/access-denied?module=users");
  const { dict, locale } = await getDictionary();
  const m = dict.modules.users;
  const { edit: editId, resetPassword: resetId } = await searchParams;

  const [users, sitesForPicker, employees, roles] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { plant: { include: { site: true } }, employee: true } }),
    // Registered by Plant code only, not a specific Station — same
    // reasoning as Employees/Equipment (see resolvePlantIdForSite in
    // siteScope.ts). Leaving the site unset (an ADMIN account needs no
    // home plant) leaves plantId null — same "no plant" outcome as before.
    prisma.site.findMany({ where: { plants: { some: {} } }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.employee.findMany({ orderBy: { name: "asc" } }),
    // Every role, DRIVER included — unlike the Permissions/getAllRoles
    // list (which excludes DRIVER because drivers never see the module
    // sidebar), an account still needs to be creatable as a Driver here.
    prisma.role.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const roleLabel = (key: string) => roles.find((r) => r.key === key)?.[locale === "ar" ? "labelAr" : "labelEn"] ?? key;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.name}</th>
                <th className={ui.th}>{m.col.email}</th>
                <th className={ui.th}>{m.col.role}</th>
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.employee}</th>
                <th className={ui.th}>{m.col.status}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                if (editId === u.id) {
                  return (
                    <tr key={u.id}>
                      <td className={ui.td} colSpan={7}>
                        <form action={updateUser} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={u.id} />
                          <div>
                            <label className={ui.label}>{m.f.name}</label>
                            <input name="name" defaultValue={u.name} required className={`${ui.input} w-36`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.role}</label>
                            <select name="role" defaultValue={u.role} required className={`${ui.select} w-40`}>
                              {roles.map((r) => (
                                <option key={r.key} value={r.key}>{roleLabel(r.key)}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{dict.field.siteCode}</label>
                            <select name="siteId" defaultValue={u.plant?.siteId ?? ""} className={`${ui.select} w-36`}>
                              <option value="">{dict.field.none}</option>
                              {sitesForPicker.map((s) => (
                                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.employee}</label>
                            <select name="employeeId" defaultValue={u.employeeId ?? ""} className={`${ui.select} w-36`}>
                              <option value="">{dict.field.none}</option>
                              {employees.map((e) => (
                                <option key={e.id} value={e.id}>{e.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.col.status}</label>
                            <select name="status" defaultValue={u.status} className={`${ui.select} w-32`}>
                              <option value="ACTIVE">{m.statusActive}</option>
                              <option value="DISABLED">{m.statusDisabled}</option>
                            </select>
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/users" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  );
                }
                if (resetId === u.id) {
                  return (
                    <tr key={u.id}>
                      <td className={ui.td} colSpan={7}>
                        <form action={resetUserPassword} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={u.id} />
                          <div>
                            <label className={ui.label}>{m.newPassword}</label>
                            <input
                              name="password"
                              type="password"
                              minLength={8}
                              required
                              className={`${ui.input} w-48`}
                              dir="ltr"
                            />
                          </div>
                          <button className={ui.button}>{m.resetPassword}</button>
                          <Link href="/users" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={u.id}>
                    <td className={`${ui.td} font-medium`}>{u.name}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{u.email}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{roleLabel(u.role)}</td>
                    <td className={ui.td}>{u.plant ? `${u.plant.site.code} — ${u.plant.site.name}` : "—"}</td>
                    <td className={ui.td}>{u.employee?.name ?? "—"}</td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${u.status === "ACTIVE" ? "bg-good-soft text-good" : "bg-surface-alt text-ink-muted"}`}>
                        {u.status === "ACTIVE" ? m.statusActive : m.statusDisabled}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <div className="flex items-center gap-2">
                        <Link href={`/users?edit=${u.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                        <Link href={`/users?resetPassword=${u.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {m.resetPassword}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={7}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createUser} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.email}</label>
            <input name="email" type="email" required className={ui.input} dir="ltr" placeholder="you@plant.example" />
          </div>
          <div>
            <label className={ui.label}>{m.f.password}</label>
            <input name="password" type="password" minLength={8} required className={ui.input} dir="ltr" />
            <p className="mt-1 text-xs text-ink-muted">{m.passwordHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f.role}</label>
            <select name="role" required className={ui.select}>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>{roleLabel(r.key)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{dict.field.siteCode}</label>
            <select name="siteId" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {sitesForPicker.map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.employee}</label>
            <select name="employeeId" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">{m.employeeHint}</p>
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
