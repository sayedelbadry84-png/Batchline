import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";

export default async function DashboardPage() {
  const [plantCount, siloCount, mixCount, customerCount, projectCount, reservationCount, lowSilos] =
    await Promise.all([
      prisma.plant.count(),
      prisma.silo.count(),
      prisma.mixDesign.count(),
      prisma.customer.count(),
      prisma.project.count(),
      prisma.reservation.count(),
      prisma.silo.findMany({ include: { plant: true } }),
    ]);

  const alerts = lowSilos
    .map((s) => ({ ...s, pct: s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0 }))
    .filter((s) => s.pct <= s.minThresholdPct)
    .sort((a, b) => a.pct - b.pct);

  const stats = [
    { label: "Plants", value: plantCount, href: "/plants" },
    { label: "Silos", value: siloCount, href: "/silos" },
    { label: "Mix designs", value: mixCount, href: "/mix-designs" },
    { label: "Customers", value: customerCount, href: "/customers" },
    { label: "Projects", value: projectCount, href: "/projects" },
    { label: "Reservations", value: reservationCount, href: "/reservations" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Overview</div>
        <h1 className={ui.h1}>Plant overview</h1>
        <p className={ui.intro}>
          Phase 1 foundation is live: plants, silos, mix designs, customers,
          suppliers, projects, employees, and reservations, all backed by a
          real database. Production, Fleet, and hardware integrations land in
          later phases per the rollout plan.
        </p>
      </header>

      {alerts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-transparent bg-warn-soft px-5 py-4 text-warn">
          <div className="font-mono text-xs tracking-wide uppercase">Silo alerts</div>
          {alerts.map((s) => (
            <div key={s.id} className="text-sm">
              <Link href="/silos" className="font-medium hover:underline">
                {s.name}
              </Link>{" "}
              at {s.plant.name} is at {s.pct.toFixed(0)}% — at or below its {s.minThresholdPct}% threshold.
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className={`${ui.card} block transition-shadow hover:shadow-md`}>
            <div className="font-mono text-3xl tabular">{s.value}</div>
            <div className="mt-1 text-sm text-ink-muted">{s.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
