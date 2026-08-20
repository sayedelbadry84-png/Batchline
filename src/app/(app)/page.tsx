import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getDictionary } from "@/lib/i18n";

export default async function DashboardPage() {
  const { dict } = await getDictionary();

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
    { label: dict.dashboard.stats.plants, value: plantCount, href: "/plants" },
    { label: dict.dashboard.stats.silos, value: siloCount, href: "/silos" },
    { label: dict.dashboard.stats.mixDesigns, value: mixCount, href: "/mix-designs" },
    { label: dict.dashboard.stats.trucks, value: truckCount, href: "/fleet" },
    { label: dict.dashboard.stats.openTrips, value: openTrips.length, href: "/trips" },
    { label: dict.dashboard.stats.customers, value: customerCount, href: "/customers" },
    { label: dict.dashboard.stats.projects, value: projectCount, href: "/projects" },
    { label: dict.dashboard.stats.reservations, value: reservationCount, href: "/reservations" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{dict.dashboard.eyebrow}</div>
        <h1 className={ui.h1}>{dict.dashboard.title}</h1>
        <p className={ui.intro}>{dict.dashboard.intro}</p>
      </header>

      {siloAlerts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-transparent bg-warn-soft px-5 py-4 text-warn">
          <div className="font-mono text-xs tracking-wide uppercase">{dict.dashboard.siloAlerts}</div>
          {siloAlerts.map((s) => (
            <div key={s.id} className="text-sm">
              <Link href="/silos" className="font-medium hover:underline">
                {s.name}
              </Link>{" "}
              {dict.dashboard.siloAlertRest(s.plant.name, s.pct.toFixed(0), s.minThresholdPct)}
            </div>
          ))}
        </div>
      )}

      {drumAlerts.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-transparent bg-critical-soft px-5 py-4 text-critical">
          <div className="font-mono text-xs tracking-wide uppercase">{dict.dashboard.drumAlerts}</div>
          {drumAlerts.map((t) => (
            <div key={t.id} className="text-sm">
              <Link href="/trips" className="font-medium hover:underline">
                {t.truck.code}
              </Link>{" "}
              {dict.dashboard.drumAlertRest(t.elapsedMin, t.batchTicket.plant.drumTimerLimitMinutes)}
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
