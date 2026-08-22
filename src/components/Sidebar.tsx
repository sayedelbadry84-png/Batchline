"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";
import { setLocale } from "@/app/locale-actions";
import { MODULE_NAV, VIEW_NAV, type ModuleKey } from "@/lib/permissions";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/config";

export function Sidebar({
  user,
  allowedModules,
  nav,
  common,
  locale,
}: {
  user: { name: string; role: string };
  // Computed server-side (permissions are database-backed — see
  // src/lib/permissions.ts) and handed down as plain data, since this
  // Client Component can't reach the database itself.
  allowedModules: ModuleKey[];
  // Only the plain-string slices this Client Component needs — never pass
  // the whole Dictionary across the boundary, since other sections (e.g.
  // dashboard, driver) hold formatter functions that can't be serialized
  // to a Client Component.
  nav: Dictionary["nav"];
  common: Dictionary["common"];
  locale: Locale;
}) {
  const pathname = usePathname();
  const canSee = (key: ModuleKey) => allowedModules.includes(key);

  return (
    <nav className="no-print sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border px-4 py-6">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-display text-xl font-semibold tracking-tight">
          Batchline
        </span>
      </div>
      <div className="mb-6 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
        {nav.section}
      </div>
      {MODULE_NAV.filter((m) => canSee(m.key)).map((m) => {
        const active =
          m.href === "/" ? pathname === "/" : pathname.startsWith(m.href);
        return (
          <Link
            key={m.href}
            href={m.href}
            className={`flex items-center gap-3 rounded-md border-s-2 px-3 py-2 text-sm ${
              active
                ? "border-accent bg-surface-alt font-medium text-ink"
                : "border-transparent text-ink-muted hover:bg-surface-alt hover:text-ink"
            }`}
          >
            <span
              className={`font-mono text-xs ${active ? "text-accent-strong" : "text-ink-faint"}`}
            >
              {m.num}
            </span>
            {nav[m.labelKey]}
          </Link>
        );
      })}

      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-1 px-3 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
          {nav.liveViews}
        </div>
        {VIEW_NAV.filter((v) => canSee(v.key)).map((v) => {
          const active = pathname.startsWith(v.href);
          return (
            <Link
              key={v.href}
              href={v.href}
              className={`flex items-center gap-3 rounded-md border-s-2 px-3 py-2 text-sm ${
                active
                  ? "border-accent bg-surface-alt font-medium text-ink"
                  : "border-transparent text-ink-muted hover:bg-surface-alt hover:text-ink"
              }`}
            >
              {nav[v.labelKey]}
            </Link>
          );
        })}
      </div>

      {user.role === "ADMIN" && (
        <div className="mt-4 border-t border-border pt-4">
          <div className="mb-1 px-3 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
            {nav.administration}
          </div>
          <Link
            href="/permissions"
            className={`flex items-center gap-3 rounded-md border-s-2 px-3 py-2 text-sm ${
              pathname.startsWith("/permissions")
                ? "border-accent bg-surface-alt font-medium text-ink"
                : "border-transparent text-ink-muted hover:bg-surface-alt hover:text-ink"
            }`}
          >
            {nav.permissions}
          </Link>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
        <div className="px-3">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="font-mono text-[0.68rem] text-ink-faint">{user.role.replaceAll("_", " ")}</div>
        </div>
        <div className="flex gap-2">
          <form action={logout} className="flex-1">
            <button className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-alt hover:text-ink">
              {nav.signOut}
            </button>
          </form>
          <form action={setLocale}>
            <input type="hidden" name="locale" value={locale === "ar" ? "en" : "ar"} />
            <button className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:bg-surface-alt hover:text-ink">
              {common.switchLocale}
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
