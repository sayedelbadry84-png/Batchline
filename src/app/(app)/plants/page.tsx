import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createPlant, updatePlant, updatePlantThresholds } from "./actions";

export default async function PlantsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requirePageAccess("plants");
  const { dict } = await getDictionary();
  const m = dict.modules.plants;
  const { edit: editId } = await searchParams;

  const plants = await prisma.plant.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { silos: true, employees: true, projects: true } } },
  });

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
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.city}</th>
                <th className={ui.th}>{m.col.currency}</th>
                <th className={ui.th}>{m.col.silos}</th>
                <th className={ui.th}>{m.col.employees}</th>
                <th className={ui.th}>{m.col.projects}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {plants.map((p) =>
                editId === p.id ? (
                  <tr key={p.id}>
                    <td className={ui.td} colSpan={7}>
                      <form action={updatePlant} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <div>
                          <label className={ui.label}>{m.f.name}</label>
                          <input name="name" defaultValue={p.name} required className={`${ui.input} w-40`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.city}</label>
                          <input name="city" defaultValue={p.city} required className={`${ui.input} w-36`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.currency}</label>
                          <input name="currency" defaultValue={p.currency} className={`${ui.input} w-20`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.timezone}</label>
                          <input name="timezone" defaultValue={p.timezone} className={`${ui.input} w-36`} dir="ltr" />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href="/plants" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td className={`${ui.td} font-medium`}>{p.name}</td>
                    <td className={ui.td}>{p.city}</td>
                    <td className={`${ui.td} font-mono`} dir="ltr">{p.currency}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p._count.silos}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p._count.employees}</td>
                    <td className={`${ui.td} font-mono tabular`}>{p._count.projects}</td>
                    <td className={ui.td}>
                      <Link href={`/plants?edit=${p.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {plants.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={7}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createPlant} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} placeholder="Plant 02 — 6th of October" />
          </div>
          <div>
            <label className={ui.label}>{m.f.city}</label>
            <input name="city" required className={ui.input} placeholder="6th of October City" />
          </div>
          <div>
            <label className={ui.label}>{m.f.currency}</label>
            <input name="currency" defaultValue="EGP" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.timezone}</label>
            <input name="timezone" defaultValue="Africa/Cairo" className={ui.input} dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.thresholdsTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.thresholdsIntro}</p>
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
                <label className={ui.label}>{m.drumLimit}</label>
                <input
                  name="drumTimerLimitMinutes"
                  type="number"
                  defaultValue={p.drumTimerLimitMinutes}
                  className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className={ui.label}>{m.returnThreshold}</label>
                <input
                  name="returnAbsorptionThresholdM3"
                  type="number"
                  step="0.1"
                  defaultValue={p.returnAbsorptionThresholdM3}
                  className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">
                {m.save}
              </button>
            </form>
          ))}
        </div>
      </div>
    </div>
  );
}
