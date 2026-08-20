import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createPlant, updatePlantThresholds } from "./actions";

export default async function PlantsPage() {
  await requirePageAccess("plants");

  const plants = await prisma.plant.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { silos: true, employees: true, projects: true } } },
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 12 — Plant Management</div>
        <h1 className={ui.h1}>Plants</h1>
        <p className={ui.intro}>
          Every silo, employee, and project is scoped to a plant. Register a
          plant here before configuring its silos or assigning staff.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Plant</th>
                <th className={ui.th}>City</th>
                <th className={ui.th}>Currency</th>
                <th className={ui.th}>Silos</th>
                <th className={ui.th}>Employees</th>
                <th className={ui.th}>Projects</th>
              </tr>
            </thead>
            <tbody>
              {plants.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-medium`}>{p.name}</td>
                  <td className={ui.td}>{p.city}</td>
                  <td className={`${ui.td} font-mono`}>{p.currency}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p._count.silos}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p._count.employees}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p._count.projects}</td>
                </tr>
              ))}
              {plants.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">
                      No plants yet — add your first one.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createPlant} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New plant</h2>
          <div>
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} placeholder="Plant 02 — 6th of October" />
          </div>
          <div>
            <label className={ui.label}>City</label>
            <input name="city" required className={ui.input} placeholder="6th of October City" />
          </div>
          <div>
            <label className={ui.label}>Currency</label>
            <input name="currency" defaultValue="EGP" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Timezone</label>
            <input name="timezone" defaultValue="Africa/Cairo" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add plant
          </button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">Batching tolerance &amp; alert thresholds</h2>
        <p className="mb-3 text-sm text-ink-muted">
          Drives the drum-timer alert on the Trip Board and the return/discount
          policy when a trip closes with unused concrete.
        </p>
        <div className="flex flex-col gap-3">
          {plants.map((p) => (
            <form
              key={p.id}
              action={updatePlantThresholds}
              className="flex flex-wrap items-end gap-4 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <input type="hidden" name="id" value={p.id} />
              <div className="min-w-32 font-medium">{p.name}</div>
              <div>
                <label className={ui.label}>Drum timer limit (min)</label>
                <input
                  name="drumTimerLimitMinutes"
                  type="number"
                  defaultValue={p.drumTimerLimitMinutes}
                  className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className={ui.label}>Return absorption threshold (m³)</label>
                <input
                  name="returnAbsorptionThresholdM3"
                  type="number"
                  step="0.1"
                  defaultValue={p.returnAbsorptionThresholdM3}
                  className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">
                Save
              </button>
            </form>
          ))}
        </div>
      </div>
    </div>
  );
}
