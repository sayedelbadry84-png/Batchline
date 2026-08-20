"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/login/actions";

// Numbered to match the 12-module system scope. `roles` gates nav
// visibility (not a security boundary by itself — the actions that matter
// enforce their own requireRole checks; this just keeps the menu honest
// about what a role can actually do).
const MODULES = [
  { href: "/", label: "Dashboard", num: "00", roles: null },
  { href: "/mix-designs", label: "Mix Design", num: "01", roles: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"] },
  { href: "/reservations", label: "Reservations", num: "02", roles: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"] },
  { href: "/production", label: "Production", num: "03", roles: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"] },
  { href: "/material-receiving", label: "Material Receiving", num: "04", roles: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"] },
  { href: "/fleet", label: "Fleet", num: "05", roles: ["PLANT_OPERATOR", "ADMIN"] },
  { href: "/silos", label: "Silos", num: "06", roles: ["PLANT_OPERATOR", "ADMIN"] },
  { href: "/customers", label: "Customers", num: "07", roles: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"] },
  { href: "/suppliers", label: "Suppliers", num: "08", roles: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"] },
  { href: "/projects", label: "Projects", num: "09", roles: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"] },
  { href: "/employees", label: "Employees", num: "10", roles: ["ADMIN"] },
  { href: "/pumps", label: "Pumps", num: "11", roles: ["PLANT_OPERATOR", "ADMIN"] },
  { href: "/plants", label: "Plant Management", num: "12", roles: ["PLANT_OPERATOR", "ADMIN"] },
] as const;

const VIEWS = [
  { href: "/trips", label: "Trip Board", roles: ["PLANT_OPERATOR", "ADMIN"] },
  { href: "/quality", label: "Quality & Compliance", roles: ["QUALITY_SUPERVISOR", "PLANT_OPERATOR", "ADMIN"] },
  { href: "/reports", label: "Reports & KPIs", roles: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN"] },
] as const;

export function Sidebar({ user }: { user: { name: string; role: string } }) {
  const pathname = usePathname();
  const canSee = (roles: readonly string[] | null) => !roles || roles.includes(user.role);

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
      {MODULES.filter((m) => canSee(m.roles)).map((m) => {
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
        {VIEWS.filter((v) => canSee(v.roles)).map((v) => {
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
