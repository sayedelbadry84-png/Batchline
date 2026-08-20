"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Numbered to match the 12-module system scope.
const MODULES = [
  { href: "/", label: "Dashboard", num: "00" },
  { href: "/mix-designs", label: "Mix Design", num: "01" },
  { href: "/reservations", label: "Reservations", num: "02" },
  { href: "/production", label: "Production", num: "03" },
  { href: "/material-receiving", label: "Material Receiving", num: "04" },
  { href: "/fleet", label: "Fleet", num: "05" },
  { href: "/silos", label: "Silos", num: "06" },
  { href: "/customers", label: "Customers", num: "07" },
  { href: "/suppliers", label: "Suppliers", num: "08" },
  { href: "/projects", label: "Projects", num: "09" },
  { href: "/employees", label: "Employees", num: "10" },
  { href: "/pumps", label: "Pumps", num: "11" },
  { href: "/plants", label: "Plant Management", num: "12" },
];

// Cross-cutting operational views, not part of the numbered 12-module list.
const VIEWS = [
  { href: "/trips", label: "Trip Board" },
  { href: "/quality", label: "Quality & Compliance" },
  { href: "/reports", label: "Reports & KPIs" },
];

export function Sidebar() {
  const pathname = usePathname();

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
      {MODULES.map((m) => {
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
        {VIEWS.map((v) => {
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

      <div className="mt-4 border-t border-border pt-4">
        <Link
          href="/driver"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-muted hover:bg-surface-alt hover:text-ink"
        >
          <span className="font-mono text-xs text-ink-faint">↗</span>
          Driver App
        </Link>
        <p className="px-3 pt-1 text-[0.68rem] text-ink-faint">
          Separate mobile-first surface for drivers.
        </p>
      </div>
    </nav>
  );
}
