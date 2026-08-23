import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createSite, updateSite, createPlant, updatePlant, updatePlantThresholds } from "./actions";

export default async function PlantsPage({
  searchParams,
}: {
  searchParams: Promise<{ editSite?: string; editPlant?: string }>;
}) {
  await requirePageAccess("plants");
  const { dict } = await getDictionary();
  const m = dict.modules.plants;
  const { editSite: editSiteId, editPlant: editPlantId } = await searchParams;

  const sites = await prisma.site.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      plants: {
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { silos: true, employees: true, projects: true } } },
      },
    },
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.sitesTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.sitesIntro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.col.siteCode}</th>
                  <th className={ui.th}>{m.col.site}</th>
                  <th className={ui.th}>{m.col.city}</th>
                  <th className={ui.th}>{m.col.country}</th>
                  <th className={ui.th}>{m.col.lines}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) =>
                  editSiteId === s.id ? (
                    <tr key={s.id}>
                      <td className={ui.td} colSpan={6}>
                        <form action={updateSite} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={s.id} />
                          <div>
                            <label className={ui.label}>{m.f.siteCode}</label>
                            <input name="code" defaultValue={s.code} required className={`${ui.input} w-24`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.siteName}</label>
                            <input name="name" defaultValue={s.name} required className={`${ui.input} w-44`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.city}</label>
                            <input name="city" defaultValue={s.city} required className={`${ui.input} w-36`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.country}</label>
                            <input name="country" defaultValue={s.country ?? ""} className={`${ui.input} w-32`} />
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/plants" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={s.id}>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{s.code}</td>
                      <td className={`${ui.td} font-medium`}>{s.name}</td>
                      <td className={ui.td}>{s.city}</td>
                      <td className={ui.td}>{s.country || "—"}</td>
                      <td className={`${ui.td} font-mono tabular`}>{s.plants.length}</td>
                      <td className={ui.td}>
                        <Link href={`/plants?editSite=${s.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      </td>
                    </tr>
                  ),
                )}
                {sites.length === 0 && (
                  <tr>
                    <td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.sitesEmpty}</span></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <form action={createSite} className={`${ui.card} flex flex-col gap-3`}>
            <h3 className="font-display text-base font-semibold">{m.newSiteTitle}</h3>
            <div>
              <label className={ui.label}>{m.f.siteCode}</label>
              <input name="code" required className={ui.input} placeholder="S1" dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.siteName}</label>
              <input name="name" required className={ui.input} placeholder="6th of October Site" />
            </div>
            <div>
              <label className={ui.label}>{m.f.city}</label>
              <input name="city" required className={ui.input} placeholder="6th of October City" />
            </div>
            <div>
              <label className={ui.label}>{m.f.country}</label>
              <input name="country" className={ui.input} placeholder="Egypt" />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.addSite}</button>
          </form>
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.linesTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.linesIntro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className="flex flex-col gap-4">
            {sites.map((s) => (
              <div key={s.id} className={ui.card}>
                <h3 className="mb-2 font-display text-sm font-semibold text-ink-muted">
                  {s.name} <span className="font-mono text-xs text-ink-faint" dir="ltr">({s.code})</span>
                </h3>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>{m.col.plant}</th>
                      <th className={ui.th}>{m.col.currency}</th>
                      <th className={ui.th}>{m.col.tax}</th>
                      <th className={ui.th}>{m.col.silos}</th>
                      <th className={ui.th}>{m.col.employees}</th>
                      <th className={ui.th}>{m.col.projects}</th>
                      <th className={ui.th}>{dict.field.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.plants.map((p) =>
                      editPlantId === p.id ? (
                        <tr key={p.id}>
                          <td className={ui.td} colSpan={7}>
                            <form action={updatePlant} className="flex flex-wrap items-end gap-2">
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="siteId" value={s.id} />
                              <div>
                                <label className={ui.label}>{m.f.name}</label>
                                <input name="name" defaultValue={p.name} required className={`${ui.input} w-32`} />
                              </div>
                              <div>
                                <label className={ui.label}>{m.f.currency}</label>
                                <input name="currency" defaultValue={p.currency} className={`${ui.input} w-20`} dir="ltr" />
                              </div>
                              <div>
                                <label className={ui.label}>{m.f.timezone}</label>
                                <input name="timezone" defaultValue={p.timezone} className={`${ui.input} w-36`} dir="ltr" />
                              </div>
                              <div>
                                <label className={ui.label}>{m.f.taxLabel}</label>
                                <input name="taxLabel" defaultValue={p.taxLabel} className={`${ui.input} w-24`} dir="ltr" />
                              </div>
                              <div>
                                <label className={ui.label}>{m.f.taxRatePct}</label>
                                <input name="taxRatePct" type="number" step="0.1" defaultValue={p.taxRatePct} className={`${ui.input} w-24`} />
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
                          <td className={`${ui.td} font-mono`} dir="ltr">{p.currency}</td>
                          <td className={`${ui.td} font-mono tabular`} dir="ltr">{p.taxLabel} {p.taxRatePct}%</td>
                          <td className={`${ui.td} font-mono tabular`}>{p._count.silos}</td>
                          <td className={`${ui.td} font-mono tabular`}>{p._count.employees}</td>
                          <td className={`${ui.td} font-mono tabular`}>{p._count.projects}</td>
                          <td className={ui.td}>
                            <Link href={`/plants?editPlant=${p.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                              {dict.field.edit}
                            </Link>
                          </td>
                        </tr>
                      ),
                    )}
                    {s.plants.length === 0 && (
                      <tr>
                        <td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.empty}</span></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          <form action={createPlant} className={`${ui.card} flex flex-col gap-3`}>
            <h3 className="font-display text-base font-semibold">{m.newTitle}</h3>
            <div>
              <label className={ui.label}>{m.f.site}</label>
              <select name="siteId" required className={ui.select}>
                <option value="">{m.selectSite}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.name}</label>
              <input name="name" required className={ui.input} placeholder="Line 1" />
            </div>
            <div>
              <label className={ui.label}>{m.f.currency}</label>
              <input name="currency" defaultValue="EGP" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.timezone}</label>
              <input name="timezone" defaultValue="Africa/Cairo" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.taxLabel}</label>
              <input name="taxLabel" defaultValue="VAT" className={ui.input} dir="ltr" />
            </div>
            <div>
              <label className={ui.label}>{m.f.taxRatePct}</label>
              <input name="taxRatePct" type="number" step="0.1" defaultValue={0} className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.add}</button>
          </form>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.thresholdsTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.thresholdsIntro}</p>
        <div className="flex flex-col gap-3">
          {sites.flatMap((s) => s.plants).map((p) => (
            <form
              key={p.id}
              action={updatePlantThresholds}
              className="flex flex-wrap items-end gap-4 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="yardLat" value={p.yardLat ?? ""} />
              <input type="hidden" name="yardLng" value={p.yardLng ?? ""} />
              <input type="hidden" name="yardRadiusM" value={p.yardRadiusM ?? ""} />
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
              <div>
                <label className={ui.label}>{m.maintenanceInterval}</label>
                <input
                  name="maintenanceIntervalTrips"
                  type="number"
                  defaultValue={p.maintenanceIntervalTrips}
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

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.yardTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.yardIntro}</p>
        <div className="flex flex-col gap-3">
          {sites.flatMap((s) => s.plants).map((p) => (
            <form
              key={p.id}
              action={updatePlantThresholds}
              className="flex flex-wrap items-end gap-4 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="drumTimerLimitMinutes" value={p.drumTimerLimitMinutes} />
              <input type="hidden" name="returnAbsorptionThresholdM3" value={p.returnAbsorptionThresholdM3} />
              <input type="hidden" name="maintenanceIntervalTrips" value={p.maintenanceIntervalTrips} />
              <div className="min-w-32 font-medium">{p.name}</div>
              <div>
                <label className={ui.label}>{m.yardLocationLink}</label>
                <input
                  name="yardLocationLink"
                  placeholder={m.yardLocationLinkPlaceholder}
                  className="w-56 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  dir="ltr"
                />
                <p className="mt-1 max-w-56 text-xs text-ink-muted">{m.yardLocationLinkHint}</p>
              </div>
              <div>
                <label className={ui.label}>{m.yardLat}</label>
                <input name="yardLat" type="number" step="0.000001" defaultValue={p.yardLat ?? undefined} className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" dir="ltr" />
              </div>
              <div>
                <label className={ui.label}>{m.yardLng}</label>
                <input name="yardLng" type="number" step="0.000001" defaultValue={p.yardLng ?? undefined} className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" dir="ltr" />
              </div>
              <div>
                <label className={ui.label}>{m.yardRadius}</label>
                <input name="yardRadiusM" type="number" step="10" defaultValue={p.yardRadiusM ?? undefined} className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" placeholder="250" />
              </div>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{m.save}</button>
            </form>
          ))}
        </div>
      </div>
    </div>
  );
}
