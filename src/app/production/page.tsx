import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { releaseBatchTicket } from "./actions";

const statusChip: Record<string, string> = {
  RELEASED: "bg-info-soft text-ink",
  BATCHING: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function ProductionPage() {
  const [readyReservations, activeTickets, recentTickets] = await Promise.all([
    prisma.reservation.findMany({
      where: { status: "CONFIRMED" },
      include: { project: { include: { customer: true } }, mix: true },
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

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 03 — Production</div>
        <h1 className={ui.h1}>Batching control room</h1>
        <p className={ui.intro}>
          Release a confirmed reservation as a batch ticket, record scale
          readings against target, and complete the batch — inventory is
          deducted from the real silo/hopper levels the moment a batch
          completes.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Ready to release</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Project</th>
                <th className={ui.th}>Mix</th>
                <th className={ui.th}>Volume</th>
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
                  <td className={`${ui.td} font-mono text-xs`}>{r.mix.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.requestedVolumeM3} m³</td>
                  <td className={ui.td}>
                    <form action={releaseBatchTicket}>
                      <input type="hidden" name="reservationId" value={r.id} />
                      <button className={ui.button}>Release batch</button>
                    </form>
                  </td>
                </tr>
              ))}
              {readyReservations.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">No confirmed reservations waiting.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Active tickets</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Ticket</th>
                <th className={ui.th}>Project</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {activeTickets.map((t) => (
                <tr key={t.id}>
                  <td className={ui.td}>
                    <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline">
                      {t.ticketNumber}
                    </Link>
                  </td>
                  <td className={ui.td}>{t.reservation.project.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{t.status}</span>
                  </td>
                </tr>
              ))}
              {activeTickets.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={3}>
                    <span className="text-ink-muted">No tickets in progress.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">Recently completed</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Ticket</th>
              <th className={ui.th}>Project</th>
              <th className={ui.th}>Volume</th>
              <th className={ui.th}>Completed</th>
              <th className={ui.th}>Trip</th>
            </tr>
          </thead>
          <tbody>
            {recentTickets.map((t) => (
              <tr key={t.id}>
                <td className={ui.td}>
                  <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline">
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
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{t.trip.status}</span>
                  ) : (
                    <span className="text-xs text-warn">no trip yet</span>
                  )}
                </td>
              </tr>
            ))}
            {recentTickets.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">Nothing completed yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
