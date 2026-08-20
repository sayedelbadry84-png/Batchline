"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";
import { canAccessModule, type ModuleKey } from "@/lib/permissions";

// Numbered to match the 12-module system scope. Visibility here comes from
// the same MODULE_ROLES map the pages enforce with requirePageAccess — one
// source of truth, so the menu can't drift from what's actually allowed.
const MODULES: { href: string; label: string; num: string; key: ModuleKey }[] = [
  { href: "/", label: "Dashboard", num: "00", key: "dashboard" },
  { href: "/mix-designs", label: "Mix Design", num: "01", key: "mix-designs" },
  { href: "/reservations", label: "Reservations", num: "02", key: "reservations" },
  { href: "/production", label: "Production", num: "03", key: "production" },
  { href: "/material-receiving", label: "Material Receiving", num: "04", key: "material-receiving" },
  { href: "/fleet", label: "Fleet", num: "05", key: "fleet" },
  { href: "/silos", label: "Silos", num: "06", key: "silos" },
  { href: "/customers", label: "Customers", num: "07", key: "customers" },
  { href: "/suppliers", label: "Suppliers", num: "08", key: "suppliers" },
  { href: "/projects", label: "Projects", num: "09", key: "projects" },
  { href: "/employees", label: "Employees", num: "10", key: "employees" },
  { href: "/pumps", label: "Pumps", num: "11", key: "pumps" },
  { href: "/plants", label: "Plant Management", num: "12", key: "plants" },
];

const VIEWS: { href: string; label: string; key: ModuleKey }[] = [
  { href: "/trips", label: "Trip Board", key: "trips" },
  { href: "/quality", label: "Quality & Compliance", key: "quality" },
  { href: "/reports", label: "Reports & KPIs", key: "reports" },
];

export function Sidebar({ user }: { user: { name: string; role: string } }) {
  const pathname = usePathname();
  const canSee = (key: ModuleKey) => canAccessModule(user.role, key);

  return (
    <nav className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border px-4 py-6">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-display text-xl font-semibold tracking-tight">
          Batchline
        </span>
      </div>
      <div className="mb-6 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
        Plant Operations
      </div>
      {MODULES.filter((m) => canSee(m.key)).map((m) => {
        const active =
          m.href === "/" ? pathname === "/" : pathname.startsWith(m.href);
        return (
          <Link
            key={m.href}
            href={m.href}
            className={`flex items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm ${
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
            {m.label}
          </Link>
        );
      })}

      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-1 px-3 font-mono text-[0.65rem] tracking-widest text-ink-faint uppercase">
          Live views
        </div>
        {VIEWS.filter((v) => canSee(v.key)).map((v) => {
          const active = pathname.startsWith(v.href);
          return (
            <Link
              key={v.href}
              href={v.href}
              className={`flex items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm ${
                active
                  ? "border-accent bg-surface-alt font-medium text-ink"
                  : "border-transparent text-ink-muted hover:bg-surface-alt hover:text-ink"
              }`}
            >
              {v.label}
            </Link>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
        <div className="px-3">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="font-mono text-[0.68rem] text-ink-faint">{user.role.replaceAll("_", " ")}</div>
        </div>
        <form action={logout}>
          <button className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-alt hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
