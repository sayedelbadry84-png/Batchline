import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createApiKey, revokeApiKey, dismissNewApiKeyReveal } from "./actions";
import { NEW_KEY_REVEAL_COOKIE } from "./constants";

const SCOPES = ["ALL", "TELEMATICS", "SCADA", "REPORTS"] as const;

export default async function IntegrationsPage() {
  // Deliberately not requirePageAccess/MODULE_ROLES — same reasoning as
  // /users and /permissions: credentials that can write GPS/silo data into
  // the system are a system-admin concern, never a database-editable grant.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/access-denied?module=integrations");

  const { dict } = await getDictionary();
  const m = dict.modules.integrations;

  const sites = await prisma.site.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" }, include: { createdBy: true } });
  const store = await cookies();
  const revealedKey = store.get(NEW_KEY_REVEAL_COOKIE)?.value ?? null;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      {revealedKey && (
        <div className={`${ui.card} border-warn`}>
          <p className="mb-2 text-sm font-medium text-warn">{m.revealWarning}</p>
          <input readOnly value={revealedKey} dir="ltr" className="w-full rounded-md border border-border bg-surface-alt px-3 py-2 font-mono text-sm" />
          <form action={dismissNewApiKeyReveal} className="mt-3">
            <button className={ui.button}>{m.dismissReveal}</button>
          </form>
        </div>
      )}

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.label}</th>
                <th className={ui.th}>{m.col.prefix}</th>
                <th className={ui.th}>{m.col.scope}</th>
                <th className={ui.th}>{m.col.lastUsed}</th>
                <th className={ui.th}>{m.col.status}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className={`${ui.td} font-medium`}>{k.label}<div className="text-xs">{k.global ? "All sites" : sites.find(s => s.id === k.siteId)?.name ?? "Unassigned — disabled"}</div></td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{k.keyPrefix}…</td>
                  <td className={ui.td}>{m.scopeLabel[k.scope as keyof typeof m.scopeLabel] ?? k.scope}</td>
                  <td className={ui.td}>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : m.neverUsed}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${k.revokedAt ? "bg-critical-soft text-critical" : "bg-good-soft text-good"}`}>
                      {k.revokedAt ? m.revoked : m.active}
                    </span>
                  </td>
                  <td className={ui.td}>
                    {!k.revokedAt && (
                      <form action={revokeApiKey}>
                        <input type="hidden" name="id" value={k.id} />
                        <button className="text-xs font-medium text-critical hover:underline">{m.revoke}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createApiKey} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <label className={ui.label}>Site / الموقع</label>
          <select name="siteId" className={ui.select} defaultValue="">
            <option value="">Select site / اختر الموقع</option>
            {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
          <label><input type="checkbox" name="global" /> All sites (leave site empty) / جميع المواقع</label>
          <div>
            <label className={ui.label}>{m.f.label}</label>
            <input name="label" required placeholder={m.f.labelPlaceholder} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.scope}</label>
            <select name="scope" required className={ui.select}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{m.scopeLabel[s]}</option>
              ))}
            </select>
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
