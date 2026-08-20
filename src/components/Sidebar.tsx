"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";
import { setLocale } from "@/app/locale-actions";
import { canAccessModule, type ModuleKey } from "@/lib/permissions";
import type { Dictionary } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/config";

// Numbered to match the 12-module system scope. Visibility comes from the
// same MODULE_ROLES map the pages enforce with requirePageAccess — one
// source of truth, so the menu can't drift from what's actually allowed.
// `labelKey` maps to nav — labels are never hardcoded English here.
const MODULES: { href: string; num: string; key: ModuleKey; labelKey: keyof Dictionary["nav"] }[] = [
  { href: "/", num: "00", key: "dashboard", labelKey: "dashboard" },
  { href: "/mix-designs", num: "01", key: "mix-designs", labelKey: "mixDesigns" },
  { href: "/reservations", num: "02", key: "reservations", labelKey: "reservations" },
  { href: "/production", num: "03", key: "production", labelKey: "production" },
  { href: "/material-receiving", num: "04", key: "material-receiving", labelKey: "materialReceiving" },
  { href: "/fleet", num: "05", key: "fleet", labelKey: "fleet" },
  { href: "/silos", num: "06", key: "silos", labelKey: "silos" },
  { href: "/customers", num: "07", key: "customers", labelKey: "customers" },
  { href: "/suppliers", num: "08", key: "suppliers", labelKey: "suppliers" },
  { href: "/projects", num: "09", key: "projects", labelKey: "projects" },
  { href: "/employees", num: "10", key: "employees", labelKey: "employees" },
  { href: "/pumps", num: "11", key: "pumps", labelKey: "pumps" },
  { href: "/plants", num: "12", key: "plants", labelKey: "plants" },
  { href: "/billing", num: "13", key: "billing", labelKey: "billing" },
];

const VIEWS: { href: string; key: ModuleKey; labelKey: keyof Dictionary["nav"] }[] = [
  { href: "/trips", key: "trips", labelKey: "trips" },
  { href: "/quality", key: "quality", labelKey: "quality" },
  { href: "/reports", key: "reports", labelKey: "reports" },
];

export function Sidebar({
  user,
  nav,
  common,
  locale,
}: {
  user: { name: string; role: string };
  // Only the plain-string slices this Client Component needs — never pass
  // the whole Dictionary across the boundary, since other sections (e.g.
  // dashboard, driver) hold formatter functions that can't be serialized
  // to a Client Component.
  nav: Dictionary["nav"];
  common: Dictionary["common"];
  locale: Locale;
}) {
  const pathname = usePathname();
  const canSee = (key: ModuleKey) => canAccessModule(user.role, key);

  return (
    <nav className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e border-border px-4 py-6">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-display text-xl font-semibold tracking-tight">
          Batchline
        </span>
      </div>
      <div className="mb-6 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
        {nav.section}
      </div>
      {MODULES.filter((m) => canSee(m.key)).map((m) => {
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
        {VIEWS.filter((v) => canSee(v.key)).map((v) => {
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
