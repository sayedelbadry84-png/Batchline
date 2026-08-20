import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createPump, schedulePump, updateAssignmentStatus } from "./actions";

const statusChip: Record<string, string> = {
  SCHEDULED: "bg-info-soft text-ink",
  ON_SITE: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function PumpsPage() {
  await requirePageAccess("pumps");
  const { dict } = await getDictionary();
  const m = dict.modules.pumps;

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
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.pump}</th>
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.type}</th>
                <th className={ui.th}>{m.col.reach}</th>
                <th className={ui.th}>{m.col.rate}</th>
                <th className={ui.th}>{m.col.status}</th>
              </tr>
            </thead>
            <tbody>
              {pumps.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-medium`} dir="ltr">{p.code}</td>
                  <td className={ui.td}>{p.plant.name}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p.reachM ? `${p.reachM} m` : "—"}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">
                    {p.hourlyRate}{m.perHour}{p.standbyRate ? m.standbySuffix(p.standbyRate) : ""}
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{dict.status[p.status as keyof typeof dict.status] ?? p.status}</span>
                  </td>
                </tr>
              ))}
              {pumps.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createPump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{dict.field.plant}</label>
            <select name="plantId" required className={ui.select}>
              <option value="">{dict.field.selectPlant}</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.code}</label>
            <input name="code" required className={ui.input} placeholder="PMP-3" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.type}</label>
            <select name="pumpType" className={ui.select}>
              <option value="BOOM">{dict.pumpTypes.BOOM}</option>
              <option value="LINE">{dict.pumpTypes.LINE}</option>
              <option value="STATIONARY">{dict.pumpTypes.STATIONARY}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.reach}</label>
            <input name="reachM" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.hourlyRate}</label>
            <input name="hourlyRate" type="number" step="1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.standbyRate}</label>
            <input name="standbyRate" type="number" step="1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.calendarTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colBooking.scheduled}</th>
                <th className={ui.th}>{m.colBooking.pump}</th>
                <th className={ui.th}>{m.colBooking.project}</th>
                <th className={ui.th}>{m.colBooking.status}</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(a.scheduledStart).toLocaleString()}</td>
                  <td className={`${ui.td} font-medium`} dir="ltr">{a.pump.code}</td>
                  <td className={ui.td}>
                    {a.reservation.project.name}
                    <div className="text-xs text-ink-muted">{a.reservation.project.customer.legalName}</div>
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[a.status] ?? ""}`}>{dict.status[a.status as keyof typeof dict.status] ?? a.status}</span>
                  </td>
                  <td className={ui.td}>
                    {a.status !== "COMPLETE" && a.status !== "CANCELLED" && (
                      <form action={updateAssignmentStatus} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={a.id} />
                        <select name="status" defaultValue={a.status} className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <option value="SCHEDULED">{dict.status.SCHEDULED}</option>
                          <option value="ON_SITE">{dict.status.ON_SITE}</option>
                          <option value="COMPLETE">{dict.status.COMPLETE}</option>
                          <option value="CANCELLED">{dict.status.CANCELLED}</option>
                        </select>
                        <input
                          name="billedHours"
                          type="number"
                          step="0.5"
                          placeholder="hrs"
                          defaultValue={a.billedHours ?? undefined}
                          className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs"
                        />
                        <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{dict.field.save}</button>
                      </form>
                    )}
                    {a.status === "COMPLETE" && a.billedHours && (
                      <span className="font-mono text-xs text-ink-muted">{m.billed(a.billedHours)}</span>
                    )}
                  </td>
                </tr>
              ))}
              {assignments.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.emptyBookings}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={schedulePump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.scheduleTitle}</h2>
          <div>
            <label className={ui.label}>{m.fSchedule.pump}</label>
            <select name="pumpId" required className={ui.select}>
              <option value="">{dict.field.selectPump}</option>
              {pumps.filter((p) => p.status === "ACTIVE").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} ({dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fSchedule.reservation}</label>
            <select name="reservationId" required className={ui.select}>
              <option value="">{dict.field.selectReservation}</option>
              {unassignedReservations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.project.name} — {r.requestedVolumeM3} m³
                </option>
              ))}
            </select>
            {unassignedReservations.length === 0 && <p className="mt-1 text-xs text-ink-muted">{m.noReservationsNeedPump}</p>}
          </div>
          <div>
            <label className={ui.label}>{m.fSchedule.scheduledStart}</label>
            <input name="scheduledStart" type="datetime-local" required className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.book}
          </button>
        </form>
      </div>
    </div>
  );
}
