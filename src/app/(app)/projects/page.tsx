import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createProject } from "./actions";

export default async function ProjectsPage() {
  await requirePageAccess("projects");
  const { dict } = await getDictionary();
  const m = dict.modules.projects;

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
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.project}</th>
                <th className={ui.th}>{m.col.customer}</th>
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.contracted}</th>
                <th className={ui.th}>{m.col.reservations}</th>
                <th className={ui.th}>{m.col.status}</th>
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
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{dict.status[p.status as keyof typeof dict.status] ?? p.status}</span>
                  </td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createProject} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} placeholder="Nile Towers — Phase 2" />
          </div>
          <div>
            <label className={ui.label}>{m.f.customer}</label>
            <select name="customerId" required className={ui.select}>
              <option value="">{dict.field.selectCustomer}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.legalName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.plant}</label>
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
            <label className={ui.label}>{m.f.siteAddress}</label>
            <input name="siteAddress" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.contractedVolume}</label>
            <input name="contractedVolumeM3" type="number" step="1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
