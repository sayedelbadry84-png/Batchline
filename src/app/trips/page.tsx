import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { DrumTimer } from "@/components/DrumTimer";
import { advanceTrip, closeTripFull, closeTripWithReturn } from "./actions";

const statusChip: Record<string, string> = {
  LOADING: "bg-surface-alt text-ink-muted",
  IN_TRANSIT: "bg-info-soft text-ink",
  ON_SITE: "bg-accent-soft text-accent-strong",
  DISCHARGING: "bg-warn-soft text-warn",
  CLOSED: "bg-good-soft text-good",
};

const dispositionChip: Record<string, string> = {
  NO_CHARGE: "bg-good-soft text-good",
  REDISPATCHED: "bg-good-soft text-good",
  PARTIAL_CREDIT: "bg-warn-soft text-warn",
  FULL_WASTE: "bg-critical-soft text-critical",
};

export default async function TripsPage() {
  const [openTrips, closedTrips] = await Promise.all([
    prisma.trip.findMany({
      where: { status: { not: "CLOSED" } },
      include: {
        truck: true,
        driver: true,
        batchTicket: { include: { plant: true, reservation: { include: { project: true } } } },
      },
      orderBy: { batchTime: "asc" },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED" },
      include: {
        truck: true,
        driver: true,
        drumReturn: true,
        batchTicket: { include: { reservation: { include: { project: true } } } },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Modules 03 + 05 — Live trips</div>
        <h1 className={ui.h1}>Trip board</h1>
        <p className={ui.intro}>
          Every open trip against its drum timer. Closing with a return
          applies the plant&apos;s configured return &amp; discount policy —
          no charge under the absorption threshold, partial credit above it,
          full waste past the drum-timer limit.
        </p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Truck / driver</th>
              <th className={ui.th}>Project</th>
              <th className={ui.th}>Status</th>
              <th className={ui.th}>Drum timer</th>
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {openTrips.map((t) => (
              <tr key={t.id}>
                <td className={ui.td}>
                  <span className="font-medium">{t.truck.code}</span>
                  <div className="text-xs text-ink-muted">{t.driver.name}</div>
                </td>
                <td className={ui.td}>
                  {t.batchTicket.reservation.project.name}
                  <div className="font-mono text-xs text-ink-muted">{t.batchTicket.ticketNumber}</div>
                </td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{t.status}</span>
                </td>
                <td className={ui.td}>
                  <DrumTimer batchTimeIso={t.batchTime.toISOString()} limitMinutes={t.batchTicket.plant.drumTimerLimitMinutes} />
                </td>
                <td className={ui.td}>
                  {t.status !== "DISCHARGING" ? (
                    <form action={advanceTrip}>
                      <input type="hidden" name="tripId" value={t.id} />
                      <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
                        {t.status === "LOADING" ? "Depart" : t.status === "IN_TRANSIT" ? "Arrived" : "Start discharge"}
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={closeTripFull}>
                        <input type="hidden" name="tripId" value={t.id} />
                        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
                          Full load used — close
                        </button>
                      </form>
                      <form action={closeTripWithReturn} className="flex items-center gap-1">
                        <input type="hidden" name="tripId" value={t.id} />
                        <input
                          name="returnedVolumeM3"
                          type="number"
                          step="0.1"
                          placeholder="return m³"
                          required
                          className="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                        />
                        <button className="rounded-md bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn hover:opacity-80">
                          Log return &amp; close
                        </button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {openTrips.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">No open trips — start one from a completed batch ticket.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">Recently closed</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Truck</th>
              <th className={ui.th}>Project</th>
              <th className={ui.th}>Delivered</th>
              <th className={ui.th}>Return</th>
            </tr>
          </thead>
          <tbody>
            {closedTrips.map((t) => (
              <tr key={t.id}>
                <td className={`${ui.td} font-medium`}>{t.truck.code}</td>
                <td className={ui.td}>{t.batchTicket.reservation.project.name}</td>
                <td className={`${ui.td} font-mono tabular`}>{t.volumeDeliveredM3?.toFixed(1) ?? "—"} m³</td>
                <td className={ui.td}>
                  {t.drumReturn ? (
                    <span className={`${ui.chip} ${dispositionChip[t.drumReturn.disposition] ?? ""}`}>
                      {t.drumReturn.disposition} · {t.drumReturn.returnedVolumeM3} m³
                    </span>
                  ) : (
                    <span className="text-xs text-ink-muted">full load</span>
                  )}
                </td>
              </tr>
            ))}
            {closedTrips.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={4}>
                  <span className="text-ink-muted">No closed trips yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
