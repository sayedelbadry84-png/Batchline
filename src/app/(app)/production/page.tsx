import { Fragment } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { releaseBatchTicket, createManualRelease } from "./actions";
import { closeReservation } from "../reservations/actions";
import { effectiveSiteId, plantScopeWhere, reservationSiteScopeWhere } from "@/lib/siteScope";
import { sumAcceptedVolumeM3 } from "@/lib/reservations";
import { SitePlantSelect } from "@/components/SitePlantSelect";
import { Modal } from "@/components/Modal";
import { PrintButton } from "@/components/PrintButton";
import { WhatsAppShareButton } from "@/components/WhatsAppShareButton";

// A single mixer truck load — the same hard ceiling releaseBatchTicket
// enforces server-side, so this is display/UX only, not the real gate.
const MAX_LOAD_M3 = 15;

const statusChip: Record<string, string> = {
  CONFIRMED: "bg-good-soft text-good",
  IN_PRODUCTION: "bg-accent-soft text-accent-strong",
  RELEASED: "bg-info-soft text-ink",
  BATCHING: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

// Same UTC-consistent date-string arithmetic as Reservations (see that
// file's own comment) — kept local rather than shared since it's a small,
// page-specific helper and this app has no shared date-utils module yet.
function toDateParam(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(dateParam: string, delta: number): string {
  const d = new Date(`${dateParam}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return toDateParam(d);
}
function fmtTime(d: Date): string {
  return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(d: Date): string {
  return new Date(d).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<{ manualBooking?: string; date?: string; dateTo?: string }>;
}) {
  const user = await requirePageAccess("production");
  const { dict } = await getDictionary();
  const m = dict.modules.production;
  const { manualBooking, date: dateRaw, dateTo: dateToRaw } = await searchParams;
  const siteId = effectiveSiteId(user);
  const isDateParam = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const selectedDate = isDateParam(dateRaw) ? dateRaw : toDateParam(new Date());
  // Optional end date — when set and later than selectedDate, the delivery
  // log covers that whole range instead of one day (same from/to pattern
  // as Reservations and Reports). Never before selectedDate.
  const selectedDateTo = isDateParam(dateToRaw) && dateToRaw >= selectedDate ? dateToRaw : selectedDate;
  const isRange = selectedDate !== selectedDateTo;
  // Local (no "Z") — matches how releasedAt/pourWindowStart are actually
  // written elsewhere in this app (see the same note in reservations/page.tsx).
  const dayStart = new Date(`${selectedDate}T00:00:00`);
  const dayEnd = new Date(`${addDays(selectedDateTo, 1)}T00:00:00`);
  const baseUrl = `/production?date=${selectedDate}&dateTo=${selectedDateTo}`;

  const [readyReservationsRaw, allDeliveries, projects, approvedMixes, sitesForPicker] = await Promise.all([
    prisma.reservation.findMany({
      // A reservation only shows up here — and can only be released against
      // — once it's cleared both sign-offs (see the Reservations module).
      // Deliberately NOT scoped to the selected day: a multi-day pour still
      // needing more volume must stay visible regardless of which day it
      // was originally booked for — only "All Deliveries" below is a daily
      // log, this table is "what still needs action" right now.
      where: { status: { in: ["CONFIRMED", "IN_PRODUCTION"] }, initialApprovedAt: { not: null }, finalApprovedAt: { not: null }, ...reservationSiteScopeWhere(siteId) },
      include: {
        project: { include: { customer: true } },
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true, trip: { select: { volumeDeliveredM3: true } } } },
        // The station (production line) is chosen right here, at release
        // time — only that reservation's own plant's ACTIVE lines are
        // offered (see the Reservation model comment in schema.prisma).
        site: { include: { plants: { where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      },
      orderBy: { pourWindowStart: "asc" },
    }),
    // The day's actual delivery log — every ticket released today,
    // regardless of where it's gotten to since (RELEASED/BATCHING still in
    // progress, COMPLETE done) — merges what used to be two separate
    // "active" / "recently completed" tables into RhinoMaster's single
    // "All Deliveries" list.
    prisma.batchTicket.findMany({
      where: { status: { in: ["RELEASED", "BATCHING", "COMPLETE"] }, releasedAt: { gte: dayStart, lt: dayEnd }, ...plantScopeWhere(siteId) },
      include: {
        mix: true,
        plant: true,
        reservation: {
          include: {
            project: { include: { customer: true } },
            // Lifetime total, not just today's — the parent row's own
            // "released of requested" needs to reflect the whole
            // reservation, even split across more than one day.
            batchTickets: {
              where: { status: { not: "CANCELLED" } },
              select: {
                volumeM3: true,
                trip: { select: { volumeDeliveredM3: true, drumReturn: { select: { reasonCode: true, returnedVolumeM3: true } } } },
              },
            },
          },
        },
        trip: { include: { truck: true, driver: true, drumReturn: { select: { reasonCode: true, returnedVolumeM3: true } } } },
      },
      orderBy: { releasedAt: "desc" },
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
      const released = sumAcceptedVolumeM3(r.batchTickets);
      return { ...r, released, remaining: Math.max(0, r.requestedVolumeM3 - released), trips: r.batchTickets.length };
    })
    .filter((r) => r.remaining > 0.001);

  // Group today's tickets by their reservation — each reservation (even a
  // completed/DELIVERED one) becomes a parent row with its tickets
  // branching underneath, instead of a flat ticket list, so a finished
  // job's own record (status, total delivered, notes) is visible right
  // alongside the loads that made it up. Grouped in JS rather than via a
  // reservation-first query since "today's" scope is naturally ticket-
  // driven (a reservation can span more than one day).
  const deliveryGroups = new Map<string, { reservation: (typeof allDeliveries)[number]["reservation"]; tickets: typeof allDeliveries }>();
  for (const t of allDeliveries) {
    const existing = deliveryGroups.get(t.reservationId);
    if (existing) existing.tickets.push(t);
    else deliveryGroups.set(t.reservationId, { reservation: t.reservation, tickets: [t] });
  }
  const deliveryGroupList = Array.from(deliveryGroups.values());

  const rollup = { count: allDeliveries.length, qty: allDeliveries.reduce((sum, t) => sum + t.volumeM3, 0) };
  const waMessage =
    `${m.title} — ${selectedDate}${isRange ? ` → ${selectedDateTo}` : ""}\n${m.rollup(rollup.count, rollup.qty)}\n\n` +
    allDeliveries
      .map((t) => `- ${t.ticketNumber}: ${t.reservation.project.name} (${t.reservation.project.customer.legalName}) · ${t.mix.code} ${t.volumeM3}m³`)
      .join("\n");

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <form action="/production" className="flex flex-wrap items-end gap-3">
        <Link href={`/production?date=${addDays(selectedDate, -1)}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt" aria-label={m.prevDay}>
          ‹
        </Link>
        <div>
          <label className={ui.label}>{m.dateFrom}</label>
          <input type="date" name="date" defaultValue={selectedDate} className={`${ui.input} w-40`} />
        </div>
        <div>
          <label className={ui.label}>{m.dateTo}</label>
          <input type="date" name="dateTo" defaultValue={selectedDateTo} className={`${ui.input} w-40`} />
        </div>
        <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{m.applyRange}</button>
        <Link href={`/production?date=${addDays(selectedDate, 1)}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt" aria-label={m.nextDay}>
          ›
        </Link>
        <span className="mb-2 text-sm text-ink-muted">{m.rollup(rollup.count, rollup.qty)}</span>
        <div className="ms-auto mb-0.5 flex items-center gap-2">
          <PrintButton label={m.exportPdf} />
          <WhatsAppShareButton label={m.sendWhatsApp} promptLabel={m.whatsAppPrompt} message={waMessage} />
          <Link href={`${baseUrl}&manualBooking=1`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
            {m.manualBooking}
          </Link>
        </div>
      </form>

      {manualBooking === "1" && (
        <Modal title={m.manualBookingTitle} closeHref={baseUrl}>
          <form action={createManualRelease} className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{m.manualBookingIntro}</p>
            <div>
              <label className={ui.label}>{dict.field.selectProject}</label>
              <select name="projectId" required className={ui.select}>
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
              className={ui.select}
              siteLabel={dict.field.siteCode}
              plantLabel={dict.field.plant}
              sitePlaceholder={dict.field.selectSite}
              plantPlaceholder={dict.field.selectPlant}
            />
            <div>
              <label className={ui.label}>{dict.field.selectMix}</label>
              <select name="mixId" required className={ui.select}>
                <option value="">{dict.field.selectMix}</option>
                {approvedMixes.map((mx) => (
                  <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.col.remaining}</label>
              <input name="volumeM3" type="number" step="0.5" max={MAX_LOAD_M3} required className={ui.input} placeholder="15" />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.manualBookingSubmit}</button>
          </form>
        </Modal>
      )}

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.readyTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.project}</th>
              <th className={ui.th}>{m.col.reservation}</th>
              <th className={ui.th}>{m.col.mix}</th>
              <th className={ui.th}>{m.col.pourLocation}</th>
              <th className={ui.th}>{m.col.remaining}</th>
              <th className={ui.th}>{m.col.trips}</th>
              <th className={ui.th}>{m.col.status}</th>
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
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.reservationNumber}</td>
                <td className={ui.td}>
                  <span className="font-mono text-xs" dir="ltr">{r.mix.code}</span>
                  <div className="text-xs text-ink-muted">{r.mix.grade}</div>
                </td>
                <td className={`${ui.td} text-xs`}>{r.siteLocation ?? "—"}</td>
                <td className={`${ui.td} font-mono tabular`}>
                  {r.remaining} / {r.requestedVolumeM3} m³
                  {r.released > 0 && (
                    <div className="font-normal text-xs text-ink-muted">{m.releasedOf(r.released, r.requestedVolumeM3)}</div>
                  )}
                </td>
                <td className={`${ui.td} font-mono tabular text-center`}>{r.trips}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${statusChip[r.status] ?? ""}`}>{dict.status[r.status as keyof typeof dict.status] ?? r.status}</span>
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
                <td className={ui.td} colSpan={8}>
                  <span className="text-ink-muted">{m.emptyReady}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-muted">{m.maxLoadNote(MAX_LOAD_M3)}</p>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.allDeliveriesTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colAll.when}</th>
              <th className={ui.th}>{m.colAll.plant}</th>
              <th className={ui.th}>{m.colAll.customer}</th>
              <th className={ui.th}>{m.colAll.reservation}</th>
              <th className={ui.th}>{m.colAll.mix}</th>
              <th className={ui.th}>{m.colAll.pourLocation}</th>
              <th className={ui.th}>{m.colAll.qty}</th>
              <th className={ui.th}>{m.colAll.driver}</th>
              <th className={ui.th}>{m.colAll.status}</th>
            </tr>
          </thead>
          <tbody>
            {deliveryGroupList.map(({ reservation, tickets }) => {
              const totalReleased = sumAcceptedVolumeM3(reservation.batchTickets);
              const wastedM3 = reservation.batchTickets.reduce(
                (sum, t) => sum + (t.trip?.drumReturn?.reasonCode === "QUALITY_REJECTED" ? t.trip.drumReturn.returnedVolumeM3 : 0),
                0,
              );
              return (
                <Fragment key={reservation.id}>
                  <tr className="bg-surface-alt">
                    <td className={ui.td}></td>
                    <td className={ui.td}></td>
                    <td className={`${ui.td} font-medium`}>
                      {reservation.project.name}
                      <div className="text-xs font-normal text-ink-muted">{reservation.project.customer.legalName}</div>
                      <Link href={`/reservations?edit=${reservation.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{reservation.reservationNumber}</td>
                    <td className={ui.td}></td>
                    <td className={`${ui.td} text-xs`}>{reservation.siteLocation ?? "—"}</td>
                    <td className={`${ui.td} font-mono tabular`}>
                      {totalReleased} / {reservation.requestedVolumeM3} m³
                      {wastedM3 > 0 && <div className="font-normal text-xs text-critical">{m.wastedFromTotal(wastedM3)}</div>}
                    </td>
                    <td className={ui.td}></td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${statusChip[reservation.status] ?? ""}`}>
                        {dict.status[reservation.status as keyof typeof dict.status] ?? reservation.status}
                      </span>
                    </td>
                  </tr>
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td className={`${ui.td} font-mono text-xs tabular`}>{t.releasedAt ? (isRange ? fmtDateTime(t.releasedAt) : fmtTime(t.releasedAt)) : "—"}</td>
                      <td className={`${ui.td} text-xs`}>{t.plant.name}</td>
                      <td className={ui.td}>
                        <span className="text-ink-faint">↳</span>{" "}
                        <Link href={`/production/${t.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                          {t.ticketNumber}
                        </Link>
                      </td>
                      <td className={ui.td}></td>
                      <td className={ui.td}>
                        <span className="font-mono text-xs" dir="ltr">{t.mix.code}</span>
                        <div className="text-xs text-ink-muted">{t.mix.grade}</div>
                      </td>
                      <td className={ui.td}></td>
                      <td className={`${ui.td} font-mono tabular`}>
                        {t.volumeM3} m³
                        {t.trip?.drumReturn?.reasonCode === "QUALITY_REJECTED" && (
                          <div className="font-normal text-xs text-critical">
                            {m.wastedFromTotal(t.trip.drumReturn.returnedVolumeM3)} — {dict.returnReasons.QUALITY_REJECTED}
                          </div>
                        )}
                      </td>
                      <td className={`${ui.td} text-xs`}>{t.trip?.driver.name ?? "—"}</td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {deliveryGroupList.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={9}>
                  <span className="text-ink-muted">{m.emptyAll}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
