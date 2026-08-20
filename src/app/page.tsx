import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";

export default async function DashboardPage() {
  const [
    plantCount,
    siloCount,
    mixCount,
    customerCount,
    projectCount,
    reservationCount,
    truckCount,
    lowSilos,
    openTrips,
  ] = await Promise.all([
    prisma.plant.count(),
    prisma.silo.count(),
    prisma.mixDesign.count(),
    prisma.customer.count(),
    prisma.project.count(),
    prisma.reservation.count(),
    prisma.truck.count(),
    prisma.silo.findMany({ include: { plant: true } }),
    prisma.trip.findMany({
      where: { status: { not: "CLOSED" } },
      include: { truck: true, batchTicket: { include: { plant: true } } },
    }),
  ]);

  const siloAlerts = lowSilos
    .map((s) => ({ ...s, pct: s.capacityTons > 0 ? (s.currentLevelTons / s.capacityTons) * 100 : 0 }))
    .filter((s) => s.pct <= s.minThresholdPct)
    .sort((a, b) => a.pct - b.pct);

  // Server-rendered snapshot at request time, not a re-rendering client
  // component — a fresh timestamp per request is the correct behavior here.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const drumAlerts = openTrips
    .map((t) => ({
      ...t,
      elapsedMin: Math.floor((nowMs - t.batchTime.getTime()) / 60000),
    }))
    .filter((t) => t.elapsedMin > t.batchTicket.plant.drumTimerLimitMinutes);

  const stats = [
    { label: "Plants", value: plantCount, href: "/plants" },
    { label: "Silos", value: siloCount, href: "/silos" },
    { label: "Mix designs", value: mixCount, href: "/mix-designs" },
    { label: "Trucks", value: truckCount, href: "/fleet" },
    { label: "Open trips", value: openTrips.length, href: "/trips" },
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

      {siloAlerts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-transparent bg-warn-soft px-5 py-4 text-warn">
          <div className="font-mono text-xs tracking-wide uppercase">Silo alerts</div>
          {siloAlerts.map((s) => (
            <div key={s.id} className="text-sm">
              <Link href="/silos" className="font-medium hover:underline">
                {s.name}
              </Link>{" "}
              at {s.plant.name} is at {s.pct.toFixed(0)}% — at or below its {s.minThresholdPct}% threshold.
            </div>
          ))}
        </div>
      )}

      {drumAlerts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-transparent bg-critical-soft px-5 py-4 text-critical">
          <div className="font-mono text-xs tracking-wide uppercase">Drum timer alerts</div>
          {drumAlerts.map((t) => (
            <div key={t.id} className="text-sm">
              <Link href="/trips" className="font-medium hover:underline">
                {t.truck.code}
              </Link>{" "}
              has been agitating for {t.elapsedMin} min — past the {t.batchTicket.plant.drumTimerLimitMinutes} min limit.
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
