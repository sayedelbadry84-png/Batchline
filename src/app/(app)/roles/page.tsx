import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createRole, updateRoleLabels, deleteRole } from "./actions";

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  // Deliberately not requirePageAccess/MODULE_ROLES — same reasoning as
  // /users and /permissions: the role roster itself is a system-admin
  // concern, never a database-editable grant another role could end up
  // with by accident.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/access-denied?module=roles");

  const { dict } = await getDictionary();
  const m = dict.modules.roles;
  const { edit: editId } = await searchParams;

  const roles = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  const usageCounts = await prisma.user.groupBy({ by: ["role"], _count: { role: true } });
  const usage = Object.fromEntries(usageCounts.map((u) => [u.role, u._count.role]));

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
                <th className={ui.th}>{m.col.key}</th>
                <th className={ui.th}>{m.col.labelAr}</th>
                <th className={ui.th}>{m.col.labelEn}</th>
                <th className={ui.th}>{m.col.type}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => {
                if (editId === r.id) {
                  return (
                    <tr key={r.id}>
                      <td className={ui.td} colSpan={5}>
                        <form action={updateRoleLabels} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={r.id} />
                          <div>
                            <label className={ui.label}>{m.f.key}</label>
                            <input value={r.key} disabled className={`${ui.input} w-40 opacity-60`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.labelAr}</label>
                            <input name="labelAr" defaultValue={r.labelAr} required className={`${ui.input} w-40`} dir="rtl" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.labelEn}</label>
                            <input name="labelEn" defaultValue={r.labelEn} required className={`${ui.input} w-40`} dir="ltr" />
                          </div>
                          <button className={ui.button}>{m.save}</button>
                          <Link href="/roles" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  );
                }
                const count = usage[r.key] ?? 0;
                return (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.key}</td>
                    <td className={ui.td} dir="rtl">{r.labelAr}</td>
                    <td className={ui.td} dir="ltr">{r.labelEn}</td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${r.isSystem ? "bg-surface-alt text-ink-muted" : "bg-good-soft text-good"}`}>
                        {r.isSystem ? m.system : m.custom}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <div className="flex items-center gap-2">
                        <Link href={`/roles?edit=${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {m.edit}
                        </Link>
                        {!r.isSystem && (
                          count > 0 ? (
                            <span className="text-xs text-ink-faint" title={m.deleteBlockedInUse(count)}>
                              {m.delete}
                            </span>
                          ) : (
                            <form action={deleteRole}>
                              <input type="hidden" name="id" value={r.id} />
                              <button className="text-xs font-medium text-critical hover:underline">{m.delete}</button>
                            </form>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {roles.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createRole} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.key}</label>
            <input name="key" required className={ui.input} dir="ltr" placeholder="SITE_SUPERVISOR" />
            <p className="mt-1 text-xs text-ink-muted">{m.f.keyHint}</p>
          </div>
          <div>
            <label className={ui.label}>{m.f.labelAr}</label>
            <input name="labelAr" required className={ui.input} dir="rtl" />
          </div>
          <div>
            <label className={ui.label}>{m.f.labelEn}</label>
            <input name="labelEn" required className={ui.input} dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
