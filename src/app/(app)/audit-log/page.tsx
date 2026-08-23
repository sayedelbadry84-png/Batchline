import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";

const ROW_LIMIT = 300;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string; from?: string; to?: string; q?: string }>;
}) {
  // Deliberately not requirePageAccess/MODULE_ROLES — same reasoning as
  // /users and /permissions: the full company-wide activity trail is a
  // system-admin concern, never a database-editable grant another role
  // could end up with by accident.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/access-denied?module=audit-log");
  const { dict } = await getDictionary();
  const m = dict.modules.auditLog;

  const { module: moduleRaw, from: fromRaw, to: toRaw, q: qRaw } = await searchParams;
  const moduleFilter = moduleRaw?.trim() || undefined;
  const q = qRaw?.trim() || undefined;
  const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : undefined;
  const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : undefined;

  const [events, moduleOptions] = await Promise.all([
    prisma.auditEvent.findMany({
      where: {
        ...(moduleFilter ? { module: moduleFilter } : {}),
        ...(fromDate || toDate ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}),
        ...(q
          ? {
              OR: [
                { recordId: { contains: q, mode: "insensitive" } },
                { reasonCode: { contains: q, mode: "insensitive" } },
                { field: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: ROW_LIMIT,
    }),
    prisma.auditEvent.findMany({ distinct: ["module"], select: { module: true }, orderBy: { module: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <form action="/audit-log" className="flex flex-wrap items-end gap-3">
        <div>
          <label className={ui.label}>{m.f.module}</label>
          <select name="module" defaultValue={moduleFilter ?? ""} className={`${ui.select} w-44`}>
            <option value="">{m.allModules}</option>
            {moduleOptions.map((o) => (
              <option key={o.module} value={o.module}>{o.module}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.f.from}</label>
          <input name="from" type="date" defaultValue={fromRaw ?? ""} className={`${ui.input} w-40`} />
        </div>
        <div>
          <label className={ui.label}>{m.f.to}</label>
          <input name="to" type="date" defaultValue={toRaw ?? ""} className={`${ui.input} w-40`} />
        </div>
        <div>
          <label className={ui.label}>{m.f.search}</label>
          <input name="q" defaultValue={q ?? ""} placeholder={m.searchPlaceholder} className={`${ui.input} w-56`} dir="ltr" />
        </div>
        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.apply}</button>
      </form>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.when}</th>
              <th className={ui.th}>{m.col.actor}</th>
              <th className={ui.th}>{m.col.module}</th>
              <th className={ui.th}>{m.col.recordId}</th>
              <th className={ui.th}>{m.col.field}</th>
              <th className={ui.th}>{m.col.change}</th>
              <th className={ui.th}>{m.col.reasonCode}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className={`${ui.td} font-mono text-xs tabular`} dir="ltr">{new Date(e.createdAt).toLocaleString()}</td>
                <td className={ui.td}>
                  {e.actor ? (
                    <>
                      <div className="text-sm">{e.actor.name}</div>
                      <div className="font-mono text-[0.68rem] text-ink-faint" dir="ltr">{e.role}</div>
                    </>
                  ) : (
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{e.role}</span>
                  )}
                </td>
                <td className={ui.td}>{e.module}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{e.recordId}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{e.field ?? "—"}</td>
                <td className={`${ui.td} text-xs`}>
                  {e.beforeValue != null && (
                    <span className="text-ink-muted line-through">{e.beforeValue}</span>
                  )}
                  {e.beforeValue != null && e.afterValue != null && " → "}
                  {e.afterValue != null && <span dir="ltr">{e.afterValue}</span>}
                  {e.beforeValue == null && e.afterValue == null && "—"}
                </td>
                <td className={ui.td}>
                  {e.reasonCode ? (
                    <span className={`${ui.chip} ${e.reasonCode === "TRANSFERRED" ? "bg-accent-soft text-accent-strong" : "bg-surface-alt text-ink-muted"}`}>
                      {e.reasonCode}
                    </span>
                  ) : "—"}
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.empty}</span></td></tr>
            )}
          </tbody>
        </table>
        {events.length === ROW_LIMIT && <p className="mt-2 text-xs text-ink-muted">{m.limitNote(ROW_LIMIT)}</p>}
      </div>
    </div>
  );
}
