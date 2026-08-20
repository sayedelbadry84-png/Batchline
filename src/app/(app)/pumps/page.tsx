import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createPump, schedulePump, updateAssignmentStatus } from "./actions";

const statusChip: Record<string, string> = {
  SCHEDULED: "bg-info-soft text-ink",
  ON_SITE: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function PumpsPage() {
  await requirePageAccess("pumps");

  const [pumps, assignments, unassignedReservations, plants] = await Promise.all([
    prisma.pump.findMany({ orderBy: { createdAt: "asc" }, include: { plant: true } }),
    prisma.pumpAssignment.findMany({
      orderBy: { scheduledStart: "asc" },
      include: { pump: true, reservation: { include: { project: { include: { customer: true } } } } },
    }),
    prisma.reservation.findMany({
      where: { pumpAssignment: null, status: { in: ["CONFIRMED", "REQUESTED"] } },
      include: { project: true },
      orderBy: { pourWindowStart: "asc" },
    }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 11 — Pumps</div>
        <h1 className={ui.h1}>Pump fleet &amp; scheduling</h1>
        <p className={ui.intro}>
          Concrete pumps are booked and billed independently of the mixer
          fleet — by the hour, with a separate standby rate when a pour runs
          long.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Pump</th>
                <th className={ui.th}>Plant</th>
                <th className={ui.th}>Type</th>
                <th className={ui.th}>Reach</th>
                <th className={ui.th}>Rate</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {pumps.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-medium`}>{p.code}</td>
                  <td className={ui.td}>{p.plant.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{p.pumpType}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p.reachM ? `${p.reachM} m` : "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {p.hourlyRate}/hr{p.standbyRate ? ` · ${p.standbyRate}/hr standby` : ""}
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{p.status}</span>
                  </td>
                </tr>
              ))}
              {pumps.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">No pumps registered yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createPump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New pump</h2>
          <div>
            <label className={ui.label}>Plant</label>
            <select name="plantId" required className={ui.select}>
              <option value="">Select plant…</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Code</label>
            <input name="code" required className={ui.input} placeholder="PMP-3" />
          </div>
          <div>
            <label className={ui.label}>Type</label>
            <select name="pumpType" className={ui.select}>
              <option value="BOOM">Boom</option>
              <option value="LINE">Line</option>
              <option value="STATIONARY">Stationary</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>Reach (m)</label>
            <input name="reachM" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Hourly rate</label>
            <input name="hourlyRate" type="number" step="1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Standby rate</label>
            <input name="standbyRate" type="number" step="1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add pump
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Booking calendar</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Scheduled</th>
                <th className={ui.th}>Pump</th>
                <th className={ui.th}>Project</th>
                <th className={ui.th}>Status</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(a.scheduledStart).toLocaleString()}</td>
                  <td className={`${ui.td} font-medium`}>{a.pump.code}</td>
                  <td className={ui.td}>
                    {a.reservation.project.name}
                    <div className="text-xs text-ink-muted">{a.reservation.project.customer.legalName}</div>
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[a.status] ?? ""}`}>{a.status}</span>
                  </td>
                  <td className={ui.td}>
                    {a.status !== "COMPLETE" && a.status !== "CANCELLED" && (
                      <form action={updateAssignmentStatus} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={a.id} />
                        <select name="status" defaultValue={a.status} className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <option value="SCHEDULED">SCHEDULED</option>
                          <option value="ON_SITE">ON_SITE</option>
                          <option value="COMPLETE">COMPLETE</option>
                          <option value="CANCELLED">CANCELLED</option>
                        </select>
                        <input
                          name="billedHours"
                          type="number"
                          step="0.5"
                          placeholder="hrs"
                          defaultValue={a.billedHours ?? undefined}
                          className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs"
                        />
                        <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">Save</button>
                      </form>
                    )}
                    {a.status === "COMPLETE" && a.billedHours && (
                      <span className="font-mono text-xs text-ink-muted">{a.billedHours}h billed</span>
                    )}
                  </td>
                </tr>
              ))}
              {assignments.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">No pump bookings yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={schedulePump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">Schedule a pump</h2>
          <div>
            <label className={ui.label}>Pump</label>
            <select name="pumpId" required className={ui.select}>
              <option value="">Select pump…</option>
              {pumps.filter((p) => p.status === "ACTIVE").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} ({p.pumpType})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Reservation</label>
            <select name="reservationId" required className={ui.select}>
              <option value="">Select reservation…</option>
              {unassignedReservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.project.name} — {r.requestedVolumeM3} m³
                </option>
              ))}
            </select>
            {unassignedReservations.length === 0 && (
              <p className="mt-1 text-xs text-ink-muted">No reservations currently need a pump.</p>
            )}
          </div>
          <div>
            <label className={ui.label}>Scheduled start</label>
            <input name="scheduledStart" type="datetime-local" required className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Book pump
          </button>
        </form>
      </div>
    </div>
  );
}
