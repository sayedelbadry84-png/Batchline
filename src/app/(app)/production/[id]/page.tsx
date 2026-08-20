import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { recordActuals, completeBatch, startTrip } from "../actions";

const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

export default async function BatchTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id },
    include: {
      reservation: { include: { project: { include: { customer: true, plant: true } } } },
      mix: { include: { components: true } },
      components: { include: { material: true } },
      trip: { include: { truck: true, driver: true } },
    },
  });
  if (!ticket) notFound();

  const toleranceByMaterial = new Map(ticket.mix.components.map((c) => [c.materialId, c.tolerancePct]));

  const [trucks, drivers] = ticket.status === "COMPLETE" && !ticket.trip
    ? await Promise.all([
        prisma.truck.findMany({ where: { plantId: ticket.plantId, status: "ACTIVE" }, orderBy: { code: "asc" } }),
        prisma.employee.findMany({ where: { plantId: ticket.plantId, role: "DRIVER" }, orderBy: { name: "asc" } }),
      ])
    : [[], []];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between">
        <div>
          <div className={ui.eyebrow}>Module 03 — Production</div>
          <h1 className={ui.h1}>{ticket.ticketNumber}</h1>
          <p className={ui.intro}>
            {ticket.reservation.project.name} — {ticket.reservation.project.customer.legalName} · {ticket.mix.code} ·{" "}
            {ticket.volumeM3} m³
          </p>
        </div>
        <span
          className={`${ui.chip} ${
            ticket.status === "COMPLETE" ? "bg-good-soft text-good" : "bg-accent-soft text-accent-strong"
          }`}
        >
          {ticket.status}
        </span>
      </header>

      <form action={recordActuals} className={ui.card}>
        <input type="hidden" name="batchTicketId" value={ticket.id} />
        <h2 className="mb-3 font-display text-lg font-semibold">Target vs. actual</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Material</th>
              <th className={ui.th}>Target (kg)</th>
              <th className={ui.th}>Actual (kg)</th>
              <th className={ui.th}>Moisture %</th>
              <th className={ui.th}>Deviation</th>
            </tr>
          </thead>
          <tbody>
            {ticket.components.map((c) => {
              const tolerance = toleranceByMaterial.get(c.materialId) ?? 2;
              const deviationPct =
                c.actualMassKg != null ? ((c.actualMassKg - c.targetMassKg) / c.targetMassKg) * 100 : null;
              const outOfTolerance = deviationPct != null && Math.abs(deviationPct) > tolerance;
              return (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>
                    {c.material.name}
                    <div className="text-xs text-ink-muted">±{tolerance}% tolerance</div>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{c.targetMassKg.toFixed(1)}</td>
                  <td className={ui.td}>
                    <input
                      name={`actual_${c.id}`}
                      type="number"
                      step="0.1"
                      defaultValue={c.actualMassKg ?? undefined}
                      disabled={ticket.status === "COMPLETE"}
                      className="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs disabled:opacity-60"
                    />
                  </td>
                  <td className={ui.td}>
                    {AGGREGATE_TYPES.has(c.material.type) ? (
                      <input
                        name={`moisture_${c.id}`}
                        type="number"
                        step="0.1"
                        defaultValue={c.moisturePct ?? undefined}
                        disabled={ticket.status === "COMPLETE"}
                        className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs disabled:opacity-60"
                      />
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {deviationPct != null ? (
                      <span className={outOfTolerance ? "font-mono text-xs text-critical" : "font-mono text-xs text-good"}>
                        {deviationPct > 0 ? "+" : ""}
                        {deviationPct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {ticket.status !== "COMPLETE" && (
          <div className="mt-4 flex gap-3">
            <button type="submit" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
              Save readings
            </button>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-muted">
          Moisture % adjusts the batched aggregate mass automatically in a real
          weighing integration (design formula: <span className="font-mono">batched = design × (1 + moisture%)</span>);
          here it is recorded alongside the scale reading for the audit trail.
        </p>
      </form>

      {ticket.status !== "COMPLETE" && (
        <form action={completeBatch} className={`${ui.card} flex items-center justify-between`}>
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <div>
            <h2 className="font-display text-lg font-semibold">Complete batch</h2>
            <p className="text-sm text-ink-muted">
              Deducts actual (or target, if unweighed) mass from the plant&apos;s
              silo and hopper levels — the same numbers the Silos screen shows.
            </p>
          </div>
          <button type="submit" className={ui.button}>
            Complete &amp; deduct inventory
          </button>
        </form>
      )}

      {ticket.status === "COMPLETE" && !ticket.trip && (
        <form action={startTrip} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <h2 className="font-display text-lg font-semibold">Assign truck &amp; start trip</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={ui.label}>Truck</label>
              <select name="truckId" required className={ui.select}>
                <option value="">Select truck…</option>
                {trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} ({t.drumCapacityM3} m³)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>Driver</label>
              <select name="driverId" required className={ui.select}>
                <option value="">Select driver…</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className={`${ui.button} self-start`}>
            Start trip
          </button>
        </form>
      )}

      {ticket.trip && (
        <div className={`${ui.card} flex items-center justify-between`}>
          <div>
            <h2 className="font-display text-lg font-semibold">Trip {ticket.trip.status}</h2>
            <p className="text-sm text-ink-muted">
              {ticket.trip.truck.code} · {ticket.trip.driver.name}
            </p>
          </div>
          <Link href="/trips" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
            Go to live trips
          </Link>
        </div>
      )}
    </div>
  );
}
