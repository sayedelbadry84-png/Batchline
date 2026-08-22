import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { releaseBatchTicket } from "./actions";

// A single mixer truck load — the same hard ceiling releaseBatchTicket
// enforces server-side, so this is display/UX only, not the real gate.
const MAX_LOAD_M3 = 15;

const statusChip: Record<string, string> = {
  RELEASED: "bg-info-soft text-ink",
  BATCHING: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function ProductionPage() {
  await requirePageAccess("production");
  const { dict } = await getDictionary();
  const m = dict.modules.production;

  const [readyReservationsRaw, activeTickets, recentTickets] = await Promise.all([
    prisma.reservation.findMany({
      // A reservation only shows up here — and can only be released against
      // — once it's cleared both sign-offs (see the Reservations module).
      where: { status: { in: ["CONFIRMED", "IN_PRODUCTION"] }, initialApprovedAt: { not: null }, finalApprovedAt: { not: null } },
      include: {
        project: { include: { customer: true } },
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true } },
      },
      orderBy: { pourWindowStart: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: { status: { in: ["RELEASED", "BATCHING"] } },
      include: { mix: true, reservation: { include: { project: true } } },
      orderBy: { releasedAt: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: { status: "COMPLETE" },
      include: { mix: true, reservation: { include: { project: true } }, trip: true },
      orderBy: { batchCompletedAt: "desc" },
      take: 5,
    }),
  ]);

  const readyReservations = readyReservationsRaw
    .map((r) => {
      const released = r.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0);
      return { ...r, released, remaining: Math.max(0, r.requestedVolumeM3 - released) };
    })
    .filter((r) => r.remaining > 0.001);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.readyTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.project}</th>
                <th className={ui.th}>{m.col.mix}</th>
                <th className={ui.th}>{m.col.remaining}</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {readyReservations.map((r) => (
                <tr key={r.id}>
                  <td className={ui.td}>
                    {r.project.name}
                    <div className="text-xs text-ink-muted">{r.project.customer.legalName}</div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.mix.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {r.remaining} / {r.requestedVolumeM3} m³
                    {r.released > 0 && (
                      <div className="font-normal text-xs text-ink-muted">{m.releasedOf(r.released, r.requestedVolumeM3)}</div>
                    )}
                  </td>
                  <td className={ui.td}>
                    <form action={releaseBatchTicket} className="flex items-center gap-1">
                      <input type="hidden" name="reservationId" value={r.id} />
                      <input
                        name="volumeM3"
                        type="number"
                        step="0.5"
                        max={Math.min(r.remaining, MAX_LOAD_M3)}
                        defaultValue={Math.min(r.remaining, MAX_LOAD_M3)}
                        className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs"
                      />
                      <button className={ui.button}>{m.release}</button>
                    </form>
                  </td>
                </tr>
              ))}
              {readyReservations.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">{m.emptyReady}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">{m.maxLoadNote(MAX_LOAD_M3)}</p>
        </div>

        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.activeTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colTicket.ticket}</th>
                <th className={ui.th}>{m.colTicket.project}</th>
                <th className={ui.th}>{m.colTicket.status}</th>
              </tr>
            </thead>
            <tbody>
              {activeTickets.map((t) => (
                <tr key={t.id}>
                  <td className={ui.td}>
                    <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                      {t.ticketNumber}
                    </Link>
                  </td>
                  <td className={ui.td}>{t.reservation.project.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                  </td>
                </tr>
              ))}
              {activeTickets.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={3}>
                    <span className="text-ink-muted">{m.emptyActive}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.recentTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colRecent.ticket}</th>
              <th className={ui.th}>{m.colRecent.project}</th>
              <th className={ui.th}>{m.colRecent.volume}</th>
              <th className={ui.th}>{m.colRecent.completed}</th>
              <th className={ui.th}>{m.colRecent.trip}</th>
            </tr>
          </thead>
          <tbody>
            {recentTickets.map((t) => (
              <tr key={t.id}>
                <td className={ui.td}>
                  <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                    {t.ticketNumber}
                  </Link>
                </td>
                <td className={ui.td}>{t.reservation.project.name}</td>
                <td className={`${ui.td} font-mono tabular`}>{t.volumeM3} m³</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>
                  {t.batchCompletedAt ? new Date(t.batchCompletedAt).toLocaleString() : "—"}
                </td>
                <td className={ui.td}>
                  {t.trip ? (
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{dict.status[t.trip.status as keyof typeof dict.status] ?? t.trip.status}</span>
                  ) : (
                    <span className="text-xs text-warn">{m.noTripYet}</span>
                  )}
                </td>
              </tr>
            ))}
            {recentTickets.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">{m.emptyRecent}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
