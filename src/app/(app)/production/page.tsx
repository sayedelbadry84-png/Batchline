import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { releaseBatchTicket, createManualRelease } from "./actions";
import { closeReservation } from "../reservations/actions";
import { effectiveSiteId, plantScopeWhere, reservationSiteScopeWhere } from "@/lib/siteScope";
import { SitePlantSelect } from "@/components/SitePlantSelect";

// A single mixer truck load — the same hard ceiling releaseBatchTicket
// enforces server-side, so this is display/UX only, not the real gate.
const MAX_LOAD_M3 = 15;

const statusChip: Record<string, string> = {
  RELEASED: "bg-info-soft text-ink",
  BATCHING: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<{ manualBooking?: string }>;
}) {
  const user = await requirePageAccess("production");
  const { dict } = await getDictionary();
  const m = dict.modules.production;
  const { manualBooking } = await searchParams;
  const siteId = effectiveSiteId(user);

  const [readyReservationsRaw, activeTickets, recentTickets, projects, approvedMixes, sitesForPicker] = await Promise.all([
    prisma.reservation.findMany({
      // A reservation only shows up here — and can only be released against
      // — once it's cleared both sign-offs (see the Reservations module).
      where: { status: { in: ["CONFIRMED", "IN_PRODUCTION"] }, initialApprovedAt: { not: null }, finalApprovedAt: { not: null }, ...reservationSiteScopeWhere(siteId) },
      include: {
        project: { include: { customer: true } },
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true } },
        // The station (production line) is chosen right here, at release
        // time — only that reservation's own plant's ACTIVE lines are
        // offered (see the Reservation model comment in schema.prisma).
        site: { include: { plants: { where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      },
      orderBy: { pourWindowStart: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: { status: { in: ["RELEASED", "BATCHING"] }, ...plantScopeWhere(siteId) },
      include: { mix: true, reservation: { include: { project: true } } },
      orderBy: { releasedAt: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: { status: "COMPLETE", ...plantScopeWhere(siteId) },
      include: { mix: true, reservation: { include: { project: true } }, trip: true },
      orderBy: { batchCompletedAt: "desc" },
      take: 5,
    }),
    // Projects are company-wide now (see the Project model comment) — the
    // manual-booking form's own site/plant picker below is what scopes the
    // reservation this creates, not the project list.
    manualBooking ? prisma.project.findMany({ include: { customer: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    manualBooking ? prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }) : Promise.resolve([]),
    manualBooking
      ? prisma.site.findMany({
          where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
          orderBy: { code: "asc" },
          include: { plants: { orderBy: { name: "asc" }, select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);

  const readyReservations = readyReservationsRaw
    .map((r) => {
      const released = r.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0);
      return { ...r, released, remaining: Math.max(0, r.requestedVolumeM3 - released) };
    })
    .filter((r) => r.remaining > 0.001);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{m.eyebrow}</div>
          <h1 className={ui.h1}>{m.title}</h1>
          <p className={ui.intro}>{m.intro}</p>
        </div>
        {!manualBooking && (
          <Link href="/production?manualBooking=1" className="shrink-0 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
            {m.manualBooking}
          </Link>
        )}
      </header>

      {manualBooking && (
        <form action={createManualRelease} className={`${ui.card} flex flex-wrap items-end gap-3`}>
          <div className="w-full">
            <h2 className="font-display text-lg font-semibold">{m.manualBookingTitle}</h2>
            <p className="text-sm text-ink-muted">{m.manualBookingIntro}</p>
          </div>
          <div>
            <label className={ui.label}>{dict.field.selectProject}</label>
            <select name="projectId" required className={`${ui.select} w-48`}>
              <option value="">{dict.field.selectProject}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.customer.legalName}</option>
              ))}
            </select>
          </div>
          <SitePlantSelect
            sites={sitesForPicker}
            siteFieldName="siteId"
            required
            className={`${ui.select} w-40`}
            siteLabel={dict.field.siteCode}
            plantLabel={dict.field.plant}
            sitePlaceholder={dict.field.selectSite}
            plantPlaceholder={dict.field.selectPlant}
          />
          <div>
            <label className={ui.label}>{dict.field.selectMix}</label>
            <select name="mixId" required className={`${ui.select} w-40`}>
              <option value="">{dict.field.selectMix}</option>
              {approvedMixes.map((mx) => (
                <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.col.remaining}</label>
            <input name="volumeM3" type="number" step="0.5" max={MAX_LOAD_M3} required className={`${ui.input} w-24`} placeholder="15" />
          </div>
          <button type="submit" className={ui.button}>{m.manualBookingSubmit}</button>
          <Link href="/production" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
            {dict.field.cancel}
          </Link>
        </form>
      )}

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.readyTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.project}</th>
                <th className={ui.th}>{m.col.mix}</th>
                <th className={ui.th}>{m.col.remaining}</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {readyReservations.map((r) => (
                <tr key={r.id}>
                  <td className={ui.td}>
                    {r.project.name}
                    <div className="text-xs text-ink-muted">{r.project.customer.legalName}</div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.mix.code}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {r.remaining} / {r.requestedVolumeM3} m³
                    {r.released > 0 && (
                      <div className="font-normal text-xs text-ink-muted">{m.releasedOf(r.released, r.requestedVolumeM3)}</div>
                    )}
                  </td>
                  <td className={ui.td}>
                    <form action={releaseBatchTicket} className="flex items-center gap-1">
                      <input type="hidden" name="reservationId" value={r.id} />
                      <select
                        name="plantId"
                        required
                        defaultValue=""
                        className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
                      >
                        <option value="" disabled>{dict.field.selectPlant}</option>
                        {r.site.plants.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <input
                        name="volumeM3"
                        type="number"
                        step="0.5"
                        max={Math.min(r.remaining, MAX_LOAD_M3)}
                        placeholder={String(Math.min(r.remaining, MAX_LOAD_M3))}
                        className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs"
                      />
                      <button className={ui.button}>{m.release}</button>
                    </form>
                    <form action={closeReservation} className="mt-1 flex items-center gap-1">
                      <input type="hidden" name="id" value={r.id} />
                      <select name="closeReasonCode" required defaultValue="" className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs">
                        <option value="" disabled>{dict.closeReasonPlaceholder}</option>
                        {Object.entries(dict.closeReasons).map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                      <button className="text-xs font-medium text-warn hover:underline">
                        {dict.modules.reservations.closeReservation}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {readyReservations.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">{m.emptyReady}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-muted">{m.maxLoadNote(MAX_LOAD_M3)}</p>
        </div>

        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.activeTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colTicket.ticket}</th>
                <th className={ui.th}>{m.colTicket.project}</th>
                <th className={ui.th}>{m.colTicket.status}</th>
              </tr>
            </thead>
            <tbody>
              {activeTickets.map((t) => (
                <tr key={t.id}>
                  <td className={ui.td}>
                    <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                      {t.ticketNumber}
                    </Link>
                  </td>
                  <td className={ui.td}>{t.reservation.project.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                  </td>
                </tr>
              ))}
              {activeTickets.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={3}>
                    <span className="text-ink-muted">{m.emptyActive}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.recentTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colRecent.ticket}</th>
              <th className={ui.th}>{m.colRecent.project}</th>
              <th className={ui.th}>{m.colRecent.volume}</th>
              <th className={ui.th}>{m.colRecent.completed}</th>
              <th className={ui.th}>{m.colRecent.trip}</th>
            </tr>
          </thead>
          <tbody>
            {recentTickets.map((t) => (
              <tr key={t.id}>
                <td className={ui.td}>
                  <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                    {t.ticketNumber}
                  </Link>
                </td>
                <td className={ui.td}>{t.reservation.project.name}</td>
                <td className={`${ui.td} font-mono tabular`}>{t.volumeM3} m³</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>
                  {t.batchCompletedAt ? new Date(t.batchCompletedAt).toLocaleString() : "—"}
                </td>
                <td className={ui.td}>
                  {t.trip ? (
                    <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{dict.status[t.trip.status as keyof typeof dict.status] ?? t.trip.status}</span>
                  ) : (
                    <span className="text-xs text-warn">{m.noTripYet}</span>
                  )}
                </td>
              </tr>
            ))}
            {recentTickets.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">{m.emptyRecent}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
