import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { DrumTimer } from "@/components/DrumTimer";
import { logout } from "@/app/login/actions";

const statusLabel: Record<string, string> = {
  LOADING: "Loading at plant",
  IN_TRANSIT: "En route to site",
  ON_SITE: "Arrived — awaiting discharge",
  DISCHARGING: "Discharging",
};

export default async function DriverHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "DRIVER") redirect("/");

  if (!user.employeeId) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 bg-bg px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">
          Your account ({user.email}) isn&apos;t linked to a driver profile
          yet. Ask a plant admin to link it in Employees.
        </p>
        <form action={logout}>
          <button className="rounded-md border border-border px-4 py-2 text-sm">Sign out</button>
        </form>
      </div>
    );
  }

  const [openTrips, closedTrips] = await Promise.all([
    prisma.trip.findMany({
      where: { driverId: user.employeeId, status: { not: "CLOSED" } },
      include: { truck: true, batchTicket: { include: { plant: true, reservation: { include: { project: true } } } } },
      orderBy: { batchTime: "asc" },
    }),
    prisma.trip.findMany({
      where: { driverId: user.employeeId, status: "CLOSED" },
      include: { batchTicket: { include: { reservation: { include: { project: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col gap-5 bg-bg px-5 py-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-xs tracking-widest text-accent-strong uppercase">Batchline Driver</div>
          <h1 className="font-display text-xl font-semibold">{user.name}</h1>
        </div>
        <form action={logout}>
          <button className="rounded-md border border-border px-2.5 py-1.5 text-xs text-ink-muted">Sign out</button>
        </form>
      </div>

      <div className="flex flex-col gap-3">
        <div className="font-mono text-xs text-ink-muted uppercase">Today&apos;s trips</div>
        {openTrips.map((t) => (
          <Link
            key={t.id}
            href={`/driver/trip/${t.id}`}
            className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{t.batchTicket.reservation.project.name}</span>
              <span className="font-mono text-xs text-ink-muted">{t.truck.code}</span>
            </div>
            <div className="text-xs text-ink-muted">
              {t.batchTicket.ticketNumber} · {t.batchTicket.volumeM3} m³
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs font-medium">{statusLabel[t.status] ?? t.status}</span>
              <DrumTimer batchTimeIso={t.batchTime.toISOString()} limitMinutes={t.batchTicket.plant.drumTimerLimitMinutes} />
            </div>
          </Link>
        ))}
        {openTrips.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-ink-muted">
            No trips assigned right now.
          </div>
        )}
      </div>

      {closedTrips.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="font-mono text-xs text-ink-muted uppercase">Recently delivered</div>
          {closedTrips.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              {t.batchTicket.reservation.project.name}
              <span className="ml-2 font-mono text-xs text-ink-muted">{t.volumeDeliveredM3?.toFixed(1)} m³</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
