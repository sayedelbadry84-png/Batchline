import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createProject } from "./actions";

export default async function ProjectsPage() {
  await requirePageAccess("projects");

  const [projects, customers, plants] = await Promise.all([
    prisma.project.findMany({
      orderBy: { createdAt: "asc" },
      include: { customer: true, plant: true, _count: { select: { reservations: true } } },
    }),
    prisma.customer.findMany({ orderBy: { legalName: "asc" } }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 09 — Projects</div>
        <h1 className={ui.h1}>Projects</h1>
        <p className={ui.intro}>
          Groups reservations under a job site, tracked against a contracted
          volume.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Project</th>
                <th className={ui.th}>Customer</th>
                <th className={ui.th}>Plant</th>
                <th className={ui.th}>Contracted m³</th>
                <th className={ui.th}>Reservations</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-medium`}>
                    {p.name}
                    <div className="text-xs font-normal text-ink-muted">{p.siteAddress}</div>
                  </td>
                  <td className={ui.td}>{p.customer.legalName}</td>
                  <td className={ui.td}>{p.plant.name}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p.contractedVolumeM3 ?? "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{p._count.reservations}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{p.status}</span>
                  </td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">No projects yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createProject} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New project</h2>
          <div>
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} placeholder="Nile Towers — Phase 2" />
          </div>
          <div>
            <label className={ui.label}>Customer</label>
            <select name="customerId" required className={ui.select}>
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.legalName}
                </option>
              ))}
            </select>
          </div>
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
            <label className={ui.label}>Site address</label>
            <input name="siteAddress" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Contracted volume (m³)</label>
            <input name="contractedVolumeM3" type="number" step="1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add project
          </button>
        </form>
      </div>
    </div>
  );
}
