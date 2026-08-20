import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createReservation } from "./actions";

const statusChip: Record<string, string> = {
  REQUESTED: "bg-surface-alt text-ink-muted",
  CONFIRMED: "bg-good-soft text-good",
  ON_HOLD: "bg-warn-soft text-warn",
  IN_PRODUCTION: "bg-accent-soft text-accent-strong",
  DELIVERED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function ReservationsPage() {
  await requirePageAccess("reservations");

  const [reservations, projects, mixes] = await Promise.all([
    prisma.reservation.findMany({
      orderBy: { pourWindowStart: "asc" },
      include: { project: { include: { customer: true } }, mix: true },
    }),
    prisma.project.findMany({ orderBy: { name: "asc" }, include: { customer: true } }),
    prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 02 — Reservations</div>
        <h1 className={ui.h1}>Delivery schedule</h1>
        <p className={ui.intro}>
          Order intake against a project, mix, and pour window. A reservation
          for a customer with no credit limit set is auto-flagged for
          accounts review rather than silently confirmed.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Pour window</th>
                <th className={ui.th}>Project</th>
                <th className={ui.th}>Mix</th>
                <th className={ui.th}>Volume</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>
                    {new Date(r.pourWindowStart).toLocaleString()}
                  </td>
                  <td className={ui.td}>
                    {r.project.name}
                    <div className="text-xs text-ink-muted">{r.project.customer.legalName}</div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`}>{r.mix.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>{r.requestedVolumeM3} m³</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[r.status] ?? ""}`}>{r.status}</span>
                  </td>
                </tr>
              ))}
              {reservations.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">No reservations yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createReservation} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New reservation</h2>
          <div>
            <label className={ui.label}>Project</label>
            <select name="projectId" required className={ui.select}>
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.customer.legalName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Mix design</label>
            <select name="mixId" required className={ui.select}>
              <option value="">Select approved mix…</option>
              {mixes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} — {m.grade}
                </option>
              ))}
            </select>
            {mixes.length === 0 && (
              <p className="mt-1 text-xs text-warn">
                No mix is marked APPROVED yet — approve one in Mix Design first.
              </p>
            )}
          </div>
          <div>
            <label className={ui.label}>Requested volume (m³)</label>
            <input name="requestedVolumeM3" type="number" step="0.5" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Pour window start</label>
            <input name="pourWindowStart" type="datetime-local" required className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Create reservation
          </button>
        </form>
      </div>
    </div>
  );
}
