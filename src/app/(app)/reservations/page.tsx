import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createReservation, updateReservation } from "./actions";

const statusChip: Record<string, string> = {
  REQUESTED: "bg-surface-alt text-ink-muted",
  CONFIRMED: "bg-good-soft text-good",
  ON_HOLD: "bg-warn-soft text-warn",
  IN_PRODUCTION: "bg-accent-soft text-accent-strong",
  DELIVERED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requirePageAccess("reservations");
  const { dict } = await getDictionary();
  const m = dict.modules.reservations;
  const { edit: editId } = await searchParams;

  const [reservationsRaw, projects, mixes] = await Promise.all([
    prisma.reservation.findMany({
      orderBy: { pourWindowStart: "asc" },
      include: {
        project: { include: { customer: true } },
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true } },
      },
    }),
    prisma.project.findMany({ orderBy: { name: "asc" }, include: { customer: true } }),
    prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }),
  ]);

  const reservations = reservationsRaw.map((r) => ({
    ...r,
    released: r.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0),
  }));

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
                <th className={ui.th}>{m.col.pourWindow}</th>
                <th className={ui.th}>{m.col.project}</th>
                <th className={ui.th}>{m.col.mix}</th>
                <th className={ui.th}>{m.col.volume}</th>
                <th className={ui.th}>{m.col.element}</th>
                <th className={ui.th}>{m.col.delivery}</th>
                <th className={ui.th}>{m.col.status}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => {
                const editable = r.released === 0 && ["REQUESTED", "CONFIRMED", "ON_HOLD"].includes(r.status);
                if (editId === r.id && editable) {
                  return (
                    <tr key={r.id}>
                      <td className={ui.td} colSpan={8}>
                        <form action={updateReservation} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={r.id} />
                          <div>
                            <label className={ui.label}>{m.f.project}</label>
                            <select name="projectId" defaultValue={r.projectId} required className={`${ui.select} w-44`}>
                              {projects.map((p) => (
                                <option key={p.id} value={p.id}>{p.name} — {p.customer.legalName}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.mix}</label>
                            <select name="mixId" defaultValue={r.mixId} required className={`${ui.select} w-36`}>
                              {mixes.map((mx) => (
                                <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.volume}</label>
                            <input name="requestedVolumeM3" type="number" step="0.5" defaultValue={r.requestedVolumeM3} required className={`${ui.input} w-24`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.pourStart}</label>
                            <input
                              name="pourWindowStart"
                              type="datetime-local"
                              defaultValue={new Date(r.pourWindowStart).toISOString().slice(0, 16)}
                              required
                              className={`${ui.input} w-48`}
                            />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.structuralElement}</label>
                            <input name="structuralElement" defaultValue={r.structuralElement ?? ""} className={`${ui.input} w-32`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.deliveryMethod}</label>
                            <select name="deliveryMethod" defaultValue={r.deliveryMethod ?? "CHUTE"} className={`${ui.select} w-28`}>
                              <option value="CHUTE">{dict.deliveryMethods.CHUTE}</option>
                              <option value="PUMP">{dict.deliveryMethods.PUMP}</option>
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.slump}</label>
                            <input name="slumpRequestedMm" type="number" defaultValue={r.slumpRequestedMm ?? undefined} className={`${ui.input} w-24`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.temperature}</label>
                            <input name="temperatureC" type="number" step="0.5" defaultValue={r.temperatureC ?? undefined} className={`${ui.input} w-24`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.siteLocation}</label>
                            <input name="siteLocation" defaultValue={r.siteLocation ?? ""} className={`${ui.input} w-40`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.siteLocationUrl}</label>
                            <input name="siteLocationUrl" defaultValue={r.siteLocationUrl ?? ""} className={`${ui.input} w-48`} dir="ltr" placeholder="https://maps.google.com/…" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.siteContactName}</label>
                            <input name="siteContactName" defaultValue={r.siteContactName ?? ""} className={`${ui.input} w-32`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.siteContactPhone}</label>
                            <input name="siteContactPhone" defaultValue={r.siteContactPhone ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                          </div>
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="labTechnicianRequired" defaultChecked={r.labTechnicianRequired} />
                            {m.f.labTechnicianRequired}
                          </label>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/reservations" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={r.id}>
                    <td className={`${ui.td} font-mono text-xs tabular`}>
                      {new Date(r.pourWindowStart).toLocaleString()}
                    </td>
                    <td className={ui.td}>
                      {r.project.name}
                      <div className="text-xs text-ink-muted">{r.project.customer.legalName}</div>
                      {(r.siteLocation || r.siteContactName || r.siteContactPhone) && (
                        <div className="text-xs text-ink-muted">
                          {[r.siteLocation, r.siteContactName, r.siteContactPhone].filter(Boolean).join(" · ")}
                          {r.siteLocationUrl && (
                            <>
                              {" · "}
                              <a href={r.siteLocationUrl} target="_blank" rel="noopener noreferrer" className="text-accent-strong hover:underline" dir="ltr">
                                {m.mapLink}
                              </a>
                            </>
                          )}
                        </div>
                      )}
                      {r.labTechnicianRequired && (
                        <span className={`${ui.chip} bg-accent-soft text-accent-strong mt-1 inline-block`}>{m.labTechnicianBadge}</span>
                      )}
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.mix.code}</td>
                    <td className={`${ui.td} font-mono tabular`}>
                      {r.released > 0 && r.released < r.requestedVolumeM3
                        ? `${r.released} / ${r.requestedVolumeM3} m³`
                        : `${r.requestedVolumeM3} m³`}
                      {(r.slumpRequestedMm != null || r.temperatureC != null) && (
                        <div className="font-normal text-xs text-ink-muted">
                          {[
                            r.slumpRequestedMm != null ? `${r.slumpRequestedMm} mm` : null,
                            r.temperatureC != null ? `${r.temperatureC}°C` : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className={ui.td}>{r.structuralElement || "—"}</td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>
                        {dict.deliveryMethods[(r.deliveryMethod ?? "CHUTE") as keyof typeof dict.deliveryMethods] ?? r.deliveryMethod}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${statusChip[r.status] ?? ""}`}>{dict.status[r.status as keyof typeof dict.status] ?? r.status}</span>
                    </td>
                    <td className={ui.td}>
                      {editable && (
                        <Link href={`/reservations?edit=${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
              {reservations.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={8}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createReservation} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.project}</label>
            <select name="projectId" required className={ui.select}>
              <option value="">{dict.field.selectProject}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.customer.legalName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.mix}</label>
            <select name="mixId" required className={ui.select}>
              <option value="">{dict.field.selectMix}</option>
              {mixes.map((mx) => (
                <option key={mx.id} value={mx.id}>
                  {mx.code} — {mx.grade}
                </option>
              ))}
            </select>
            {mixes.length === 0 && <p className="mt-1 text-xs text-warn">{m.noApprovedMix}</p>}
          </div>
          <div>
            <label className={ui.label}>{m.f.volume}</label>
            <input name="requestedVolumeM3" type="number" step="0.5" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.pourStart}</label>
            <input name="pourWindowStart" type="datetime-local" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.structuralElement}</label>
            <input name="structuralElement" className={ui.input} placeholder="Column C12 / Slab L3" />
          </div>
          <div>
            <label className={ui.label}>{m.f.deliveryMethod}</label>
            <select name="deliveryMethod" defaultValue="CHUTE" className={ui.select}>
              <option value="CHUTE">{dict.deliveryMethods.CHUTE}</option>
              <option value="PUMP">{dict.deliveryMethods.PUMP}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.slump}</label>
            <input name="slumpRequestedMm" type="number" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.temperature}</label>
            <input name="temperatureC" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.siteLocation}</label>
            <input name="siteLocation" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.siteLocationUrl}</label>
            <input name="siteLocationUrl" className={ui.input} dir="ltr" placeholder="https://maps.google.com/…" />
          </div>
          <div>
            <label className={ui.label}>{m.f.siteContactName}</label>
            <input name="siteContactName" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.siteContactPhone}</label>
            <input name="siteContactPhone" className={ui.input} dir="ltr" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="labTechnicianRequired" />
            {m.f.labTechnicianRequired}
          </label>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.create}
          </button>
        </form>
      </div>
    </div>
  );
}
