import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { DrumTimer } from "@/components/DrumTimer";
import { advanceTrip, closeTripFull, closeTripWithReturn } from "./actions";
import { getActiveSiteId, tripPlantScopeWhere } from "@/lib/siteScope";

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
  const user = await requirePageAccess("trips");
  const { dict } = await getDictionary();
  const m = dict.modules.trips;
  const siteId = await getActiveSiteId(user);

  const [openTrips, closedTrips] = await Promise.all([
    prisma.trip.findMany({
      where: { status: { not: "CLOSED" }, ...tripPlantScopeWhere(siteId) },
      include: {
        truck: true,
        driver: true,
        batchTicket: { include: { plant: true, mix: true, reservation: { include: { project: true } } } },
      },
      orderBy: { batchTime: "asc" },
    }),
    prisma.trip.findMany({
      where: { status: "CLOSED", ...tripPlantScopeWhere(siteId) },
      include: {
        truck: true,
        driver: true,
        drumReturn: true,
        batchTicket: { include: { mix: true, reservation: { include: { project: true } } } },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.truckDriver}</th>
              <th className={ui.th}>{m.col.project}</th>
              <th className={ui.th}>{m.col.reservation}</th>
              <th className={ui.th}>{m.col.mix}</th>
              <th className={ui.th}>{m.col.pourLocation}</th>
              <th className={ui.th}>{m.col.status}</th>
              <th className={ui.th}>{m.col.drumTimer}</th>
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {openTrips.map((t) => (
              <tr key={t.id}>
                <td className={ui.td}>
                  <span className="font-medium" dir="ltr">{t.truck.code}</span>
                  <div className="text-xs text-ink-muted">{t.driver.name}</div>
                </td>
                <td className={ui.td}>
                  {t.batchTicket.reservation.project.name}
                  <div className="font-mono text-xs text-ink-muted" dir="ltr">{t.batchTicket.ticketNumber}</div>
                </td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.reservation.reservationNumber}</td>
                <td className={ui.td}>
                  <span className="font-mono text-xs" dir="ltr">{t.batchTicket.mix.code}</span>
                  <div className="text-xs text-ink-muted">{t.batchTicket.mix.grade}</div>
                </td>
                <td className={`${ui.td} text-xs`}>{t.batchTicket.reservation.siteLocation ?? "—"}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                </td>
                <td className={ui.td}>
                  <DrumTimer batchTimeIso={t.batchTime.toISOString()} limitMinutes={t.batchTicket.plant.drumTimerLimitMinutes} />
                </td>
                <td className={ui.td}>
                  {t.status !== "DISCHARGING" ? (
                    <form action={advanceTrip}>
                      <input type="hidden" name="tripId" value={t.id} />
                      <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
                        {t.status === "LOADING" ? m.depart : t.status === "IN_TRANSIT" ? m.arrived : m.startDischarge}
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={closeTripFull}>
                        <input type="hidden" name="tripId" value={t.id} />
                        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
                          {m.fullLoadClose}
                        </button>
                      </form>
                      <form action={closeTripWithReturn} className="flex items-center gap-1">
                        <input type="hidden" name="tripId" value={t.id} />
                        <input
                          name="returnedVolumeM3"
                          type="number"
                          step="0.1"
                          placeholder={m.returnPlaceholder}
                          required
                          className="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
                        />
                        <select name="reasonCode" defaultValue="" className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <option value="">{m.returnReasonPlaceholder}</option>
                          {Object.entries(dict.returnReasons).map(([k, label]) => (
                            <option key={k} value={k}>{label}</option>
                          ))}
                        </select>
                        <select name="fate" defaultValue="" className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <option value="">{m.returnFatePlaceholder}</option>
                          {Object.entries(dict.returnFates).map(([k, label]) => (
                            <option key={k} value={k}>{label}</option>
                          ))}
                        </select>
                        <button className="rounded-md bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn hover:opacity-80">
                          {m.logReturnClose}
                        </button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {openTrips.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={8}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.recentTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colClosed.truck}</th>
              <th className={ui.th}>{m.colClosed.project}</th>
              <th className={ui.th}>{m.colClosed.ticket}</th>
              <th className={ui.th}>{m.colClosed.reservation}</th>
              <th className={ui.th}>{m.colClosed.mix}</th>
              <th className={ui.th}>{m.colClosed.pourLocation}</th>
              <th className={ui.th}>{m.colClosed.delivered}</th>
              <th className={ui.th}>{m.colClosed.returnCol}</th>
            </tr>
          </thead>
          <tbody>
            {closedTrips.map((t) => (
              <tr key={t.id}>
                <td className={`${ui.td} font-medium`} dir="ltr">{t.truck.code}</td>
                <td className={ui.td}>{t.batchTicket.reservation.project.name}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.ticketNumber}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.batchTicket.reservation.reservationNumber}</td>
                <td className={ui.td}>
                  <span className="font-mono text-xs" dir="ltr">{t.batchTicket.mix.code}</span>
                  <div className="text-xs text-ink-muted">{t.batchTicket.mix.grade}</div>
                </td>
                <td className={`${ui.td} text-xs`}>{t.batchTicket.reservation.siteLocation ?? "—"}</td>
                <td className={`${ui.td} font-mono tabular`}>{t.volumeDeliveredM3?.toFixed(1) ?? "—"} m³</td>
                <td className={ui.td}>
                  {t.drumReturn ? (
                    <>
                      <span className={`${ui.chip} ${dispositionChip[t.drumReturn.disposition] ?? ""}`}>
                        {dict.status[t.drumReturn.disposition as keyof typeof dict.status] ?? t.drumReturn.disposition} · {t.drumReturn.returnedVolumeM3} m³
                      </span>
                      {(t.drumReturn.reasonCode || t.drumReturn.fate) && (
                        <div className="mt-1 text-xs text-ink-muted">
                          {[
                            t.drumReturn.reasonCode
                              ? dict.returnReasons[t.drumReturn.reasonCode as keyof typeof dict.returnReasons] ?? t.drumReturn.reasonCode
                              : null,
                            t.drumReturn.fate
                              ? dict.returnFates[t.drumReturn.fate as keyof typeof dict.returnFates] ?? t.drumReturn.fate
                              : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-ink-muted">{m.fullLoad}</span>
                  )}
                </td>
              </tr>
            ))}
            {closedTrips.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={8}>
                  <span className="text-ink-muted">{m.emptyClosed}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
