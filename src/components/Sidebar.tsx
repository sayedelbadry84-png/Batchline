"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";
import { setLocale } from "@/app/locale-actions";
import { setActiveSite } from "@/app/site-actions";
import { MODULE_NAV, VIEW_NAV, type ModuleKey } from "@/lib/permissions";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/config";
import type { Theme } from "@/lib/theme";
import { setTheme } from "@/app/theme-actions";
import { NotificationBell } from "@/components/NotificationBell";

export function Sidebar({
  user,
  allowedModules,
  nav,
  common,
  locale,
  theme,
  sites,
  activeSiteId,
  notifications,
  unreadNotificationCount,
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
  // null means no explicit choice yet (following the OS setting) — the
  // button always offers "dark" as the first press in that case, same as
  // if the current choice were "light".
  theme: Theme | null;
  // Only ever populated for ADMIN (see (app)/layout.tsx) — every other
  // role has no plant to pick, since effectiveSiteId already pins them to
  // their one site.
  sites?: { id: string; name: string }[];
  activeSiteId?: string | null;
  notifications: { id: string; title: string; body: string | null; link: string | null; readAt: Date | null; createdAt: Date }[];
  unreadNotificationCount: number;
}) {
  const pathname = usePathname();
  const canSee = (key: ModuleKey) => allowedModules.includes(key);
  // One shared shape for every nav row — a filled, rounded accent pill
  // when active instead of the old left-border stripe, matching the
  // approved glass mockup's sidebar treatment.
  const navItemClass = (active: boolean) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
      active ? "bg-accent-soft font-medium text-ink" : "text-ink-muted hover:bg-surface-alt hover:text-ink"
    }`;

  return (
    <nav className="no-print bg-glass border-glass-border sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e px-4 py-6 backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-accent-strong to-accent text-xs font-bold text-[var(--on-accent)] shadow-[0_6px_16px_-6px_var(--accent-glow)]"
          aria-hidden="true"
        >
          BL
        </div>
        <div className="leading-tight">
          <span className="font-display block text-lg font-semibold tracking-tight">Batchline</span>
          <span className="text-ink-faint block text-[0.68rem]">{common.tagline}</span>
        </div>
      </div>

      <div className="mb-4">
        <NotificationBell
          notifications={notifications}
          unreadCount={unreadNotificationCount}
          labels={{ title: common.notifications, empty: common.notificationsEmpty, markAllRead: common.markAllRead }}
        />
      </div>

      {sites && sites.length > 0 && (
        <div className="mb-4">
          <form action={setActiveSite}>
            <select
              name="siteId"
              defaultValue={activeSiteId ?? ""}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">{nav.allPlants}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </form>
          {activeSiteId && <p className="mt-1.5 px-0.5 text-[0.68rem] text-ink-faint">{nav.activePlantNote}</p>}
        </div>
      )}

      <div className="mb-6 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
        {nav.section}
      </div>
      {MODULE_NAV.filter((m) => canSee(m.key)).map((m) => {
        const active =
          m.href === "/" ? pathname === "/" : pathname.startsWith(m.href);
        return (
          <Link key={m.href} href={m.href} className={navItemClass(active)}>
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
            <Link key={v.href} href={v.href} className={navItemClass(active)}>
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
          <Link href="/users" className={navItemClass(pathname.startsWith("/users"))}>
            {nav.users}
          </Link>
          <Link href="/permissions" className={navItemClass(pathname.startsWith("/permissions"))}>
            {nav.permissions}
          </Link>
          <Link href="/roles" className={navItemClass(pathname.startsWith("/roles"))}>
            {nav.roles}
          </Link>
          <Link href="/integrations" className={navItemClass(pathname.startsWith("/integrations"))}>
            {nav.integrations}
          </Link>
          <Link href="/audit-log" className={navItemClass(pathname.startsWith("/audit-log"))}>
            {nav.auditLog}
          </Link>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
        <Link href="/account" className={navItemClass(pathname.startsWith("/account"))}>
          {nav.account}
        </Link>
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
          <form action={setTheme}>
            <input type="hidden" name="theme" value={theme === "dark" ? "light" : "dark"} />
            <button
              aria-label={common.toggleTheme}
              title={common.toggleTheme}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-alt hover:text-ink"
            >
              {theme === "dark" ? common.themeLight : common.themeDark}
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
