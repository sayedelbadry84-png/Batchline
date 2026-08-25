import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createReservation, updateReservation, approveReservationInitial, approveReservationFinal, closeReservation } from "./actions";
import { effectiveSiteId, reservationSiteScopeWhere } from "@/lib/siteScope";
import { canPerformAction } from "@/lib/permissions";
import { Modal } from "@/components/Modal";
import { SearchableSelect } from "@/components/SearchableSelect";
import { SegmentedControl } from "@/components/SegmentedControl";
import { PumpBookingRows } from "@/components/PumpBookingRows";
import { PrintButton } from "@/components/PrintButton";
import { WhatsAppShareButton } from "@/components/WhatsAppShareButton";

const statusChip: Record<string, string> = {
  REQUESTED: "bg-surface-alt text-ink-muted",
  CONFIRMED: "bg-good-soft text-good",
  ON_HOLD: "bg-warn-soft text-warn",
  IN_PRODUCTION: "bg-accent-soft text-accent-strong",
  DELIVERED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

// All date-only arithmetic here stays in UTC on purpose: toISOString()
// (used for both "today" and the addDays output) always reports the UTC
// calendar date, so parsing a "YYYY-MM-DD" string back as LOCAL midnight
// (the default `new Date("...")` behavior) would silently shift the day
// by the server's UTC offset once round-tripped through toISOString()
// again — exactly the off-by-one bug this avoids.
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

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; date?: string; new?: string }>;
}) {
  const user = await requirePageAccess("reservations");
  const { dict } = await getDictionary();
  const m = dict.modules.reservations;
  const { edit: editId, date: dateRaw, new: newFlag } = await searchParams;
  const siteId = effectiveSiteId(user);
  const selectedDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : toDateParam(new Date());
  // Local (no "Z"), NOT UTC — matches how pourWindowStart itself gets
  // parsed from a plain datetime-local string in createReservation, so
  // the query's day boundary lines up with how the data was actually
  // written rather than introducing a second, differently-interpreted
  // "day" concept.
  const dayStart = new Date(`${selectedDate}T00:00:00`);
  const dayEnd = addDays(selectedDate, 1);
  const [canApproveInitial, canApproveFinal] = await Promise.all([
    canPerformAction(user.role, "reservations", "approveInitial"),
    canPerformAction(user.role, "reservations", "approveFinal"),
  ]);

  const [reservationsRaw, projects, mixes, sitesForPicker, pumpsRaw, crew] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        ...reservationSiteScopeWhere(siteId),
        pourWindowStart: { gte: dayStart, lt: new Date(`${dayEnd}T00:00:00`) },
      },
      orderBy: { pourWindowStart: "asc" },
      include: {
        project: { include: { customer: true } },
        site: true,
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true } },
        pumpAssignments: { include: { pump: true, pumpOperator: true, pumpAssistant: true } },
      },
    }),
    // Company-wide — a project isn't tied to any one plant/line (see the
    // Project model comment), so every site can book against any project.
    prisma.project.findMany({ orderBy: { name: "asc" }, include: { customer: true } }),
    // Mix designs are a shared company-wide recipe library, not tied to a
    // site — every site should be able to pour an approved mix.
    prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }),
    // A reservation is booked against a Plant (factory) only — no specific
    // Station/line is picked here; that happens later at release time.
    prisma.site.findMany({
      where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    // Pump booking-at-reservation-time picker — company-wide, same
    // reasoning as the dispatch pickers in Production: the pump that ends
    // up on site isn't necessarily this plant's own registered unit.
    prisma.pump.findMany({
      where: { status: "ACTIVE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, reachM: true, defaultOperatorId: true, defaultAssistantId: true },
    }),
    prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
  ]);

  const reservations = reservationsRaw.map((r) => ({
    ...r,
    released: r.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0),
  }));

  const rollup = {
    count: reservations.length,
    booked: reservations.reduce((sum, r) => sum + r.requestedVolumeM3, 0),
    delivered: reservations.reduce((sum, r) => sum + r.released, 0),
  };

  const projectOptions = projects.map((p) => ({ value: p.id, label: `${p.name} — ${p.customer.legalName}` }));
  const mixOptions = mixes.map((mx) => ({ value: mx.id, label: `${mx.code} — ${mx.grade}` }));
  const operators = crew.filter((c) => c.role === "OPERATOR").map((c) => ({ id: c.id, name: c.name }));
  const assistants = crew.filter((c) => c.role === "HELPER").map((c) => ({ id: c.id, name: c.name }));

  const baseUrl = `/reservations?date=${selectedDate}`;
  const waMessage =
    `${m.title} — ${selectedDate}\n${m.rollup(rollup.count, rollup.booked, rollup.delivered)}\n\n` +
    reservations
      .map((r) => `- ${r.project.name} (${r.project.customer.legalName}): ${r.mix.code} ${r.requestedVolumeM3}m³, ${m.releasedShort(r.released)}`)
      .join("\n");

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/reservations?date=${addDays(selectedDate, -1)}`} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt" aria-label={m.prevDay}>
          ‹
        </Link>
        <input type="date" defaultValue={selectedDate} disabled className={`${ui.input} w-40`} />
        <Link href={`/reservations?date=${addDays(selectedDate, 1)}`} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt" aria-label={m.nextDay}>
          ›
        </Link>
        <span className="text-sm text-ink-muted">{m.rollup(rollup.count, rollup.booked, rollup.delivered)}</span>
        <div className="ms-auto flex items-center gap-2">
          <PrintButton label={m.exportPdf} />
          <WhatsAppShareButton label={m.sendWhatsApp} promptLabel={m.whatsAppPrompt} message={waMessage} />
          <Link href={`${baseUrl}&new=1`} className={ui.button}>
            + {m.newBooking}
          </Link>
        </div>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.time}</th>
              <th className={ui.th}>{m.col.customerSite}</th>
              <th className={ui.th}>{m.col.mix}</th>
              <th className={ui.th}>{m.col.booked}</th>
              <th className={ui.th}>{m.col.delivered}</th>
              <th className={ui.th}>{m.col.progress}</th>
              <th className={ui.th}>{m.col.pumpCrew}</th>
              <th className={ui.th}>{m.col.status}</th>
              <th className={ui.th}>{m.col.approval}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => {
              const editable = !["DELIVERED", "CANCELLED"].includes(r.status);
              if (editId === r.id && editable) {
                return (
                  <tr key={r.id}>
                    <td className={ui.td} colSpan={10}>
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
                          <label className={ui.label}>{dict.field.siteCode}</label>
                          <select name="siteId" defaultValue={r.siteId} required className={`${ui.select} w-36`}>
                            <option value="">{dict.field.selectSite}</option>
                            {sitesForPicker.map((s) => (
                              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
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
                          <input name="requestedVolumeM3" type="number" step="0.5" min={r.released} defaultValue={r.requestedVolumeM3} required className={`${ui.input} w-24`} />
                          {r.released > 0 && <p className="mt-1 text-xs text-ink-muted">{m.alreadyReleased(r.released)}</p>}
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.status}</label>
                          <select name="status" defaultValue={r.status} required className={`${ui.select} w-36`}>
                            {["REQUESTED", "CONFIRMED", "ON_HOLD", "IN_PRODUCTION", "DELIVERED", "CANCELLED"].map((s) => (
                              <option key={s} value={s}>{dict.status[s as keyof typeof dict.status] ?? s}</option>
                            ))}
                          </select>
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
                          <label className={ui.label}>{m.f.structureType}</label>
                          <select name="structureType" defaultValue={r.structureType ?? ""} className={`${ui.select} w-32`}>
                            <option value="">{dict.field.selectOne}</option>
                            {Object.entries(dict.structureTypes).map(([k, label]) => (
                              <option key={k} value={k}>{label}</option>
                            ))}
                          </select>
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
                          <label className={ui.label}>{m.f.minPumpReachM}</label>
                          <input name="minPumpReachM" type="number" step="0.5" defaultValue={r.minPumpReachM ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.slump}</label>
                          <input name="slumpRequestedMm" type="number" defaultValue={r.slumpRequestedMm ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.slumpTolerance}</label>
                          <input name="slumpToleranceMm" type="number" defaultValue={r.slumpToleranceMm ?? undefined} className={`${ui.input} w-20`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.cementType}</label>
                          <select name="cementType" defaultValue={r.cementType ?? ""} className={`${ui.select} w-24`}>
                            <option value="">{dict.field.none}</option>
                            <option value="OPC">OPC</option>
                            <option value="SRC">SRC</option>
                          </select>
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
                        <Link href={baseUrl} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                );
              }
              const progressPct = r.requestedVolumeM3 > 0 ? Math.min(100, Math.round((r.released / r.requestedVolumeM3) * 100)) : 0;
              const pumpCrewLabel = r.pumpAssignments.length
                ? r.pumpAssignments
                    .map((pa) => `${pa.pump.code}${pa.pumpOperator || pa.pumpAssistant ? ` (${[pa.pumpOperator?.name, pa.pumpAssistant?.name].filter(Boolean).join(" / ")})` : ""}`)
                    .join(", ")
                : "—";
              return (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{fmtTime(r.pourWindowStart)}</td>
                  <td className={ui.td}>
                    {r.project.name}
                    <div className="text-xs text-ink-muted">{r.project.customer.legalName} · {r.site.name}</div>
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
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.structureType && (
                        <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>
                          {dict.structureTypes[r.structureType as keyof typeof dict.structureTypes] ?? r.structureType}
                          {r.structuralElement ? ` · ${r.structuralElement}` : ""}
                        </span>
                      )}
                      <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>
                        {dict.deliveryMethods[(r.deliveryMethod ?? "CHUTE") as keyof typeof dict.deliveryMethods] ?? r.deliveryMethod}
                      </span>
                      {r.labTechnicianRequired && (
                        <span className={`${ui.chip} bg-accent-soft text-accent-strong`}>{m.labTechnicianBadge}</span>
                      )}
                    </div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">
                    {r.mix.code}
                    {(r.slumpRequestedMm != null || r.temperatureC != null || r.cementType) && (
                      <div className="font-normal text-ink-muted" dir="rtl">
                        {[
                          r.slumpRequestedMm != null ? `${r.slumpRequestedMm}${r.slumpToleranceMm != null ? `±${r.slumpToleranceMm}` : ""} mm` : null,
                          r.temperatureC != null ? `${r.temperatureC}°C` : null,
                          r.cementType,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {r.requestedVolumeM3} m³
                    {r.originalVolumeM3 != null && r.originalVolumeM3 !== r.requestedVolumeM3 && (
                      <div className="font-normal text-xs text-ink-muted">{m.originalVolume(r.originalVolumeM3)}</div>
                    )}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{r.released} m³</td>
                  <td className={ui.td}>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-alt">
                      <div className={`h-full rounded-full ${progressPct >= 100 ? "bg-good" : "bg-accent"}`} style={{ width: `${progressPct}%` }} />
                    </div>
                  </td>
                  <td className={`${ui.td} text-xs`}>{pumpCrewLabel}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[r.status] ?? ""}`}>{dict.status[r.status as keyof typeof dict.status] ?? r.status}</span>
                  </td>
                  <td className={ui.td}>
                    {r.finalApprovedAt ? (
                      <span className={`${ui.chip} bg-good-soft text-good`}>{m.approvedFinal}</span>
                    ) : r.initialApprovedAt ? (
                      <>
                        <span className={`${ui.chip} bg-warn-soft text-warn`}>{m.approvedInitial}</span>
                        {canApproveFinal ? (
                          <form action={approveReservationFinal} className="mt-1">
                            <input type="hidden" name="id" value={r.id} />
                            <button className="text-xs font-medium text-accent-strong hover:underline">{m.approveFinal}</button>
                          </form>
                        ) : (
                          <div className="mt-1 text-xs text-ink-faint">{m.pendingFinal}</div>
                        )}
                      </>
                    ) : (
                      <>
                        <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{m.pendingInitial}</span>
                        {canApproveInitial && (
                          <form action={approveReservationInitial} className="mt-1">
                            <input type="hidden" name="id" value={r.id} />
                            <button className="text-xs font-medium text-accent-strong hover:underline">{m.approveInitial}</button>
                          </form>
                        )}
                      </>
                    )}
                  </td>
                  <td className={ui.td}>
                    {editable && (
                      <div className="flex flex-col items-start gap-1">
                        <Link href={`${baseUrl}&edit=${r.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                        <form action={closeReservation} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <select name="closeReasonCode" required defaultValue="" className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs">
                            <option value="" disabled>{dict.closeReasonPlaceholder}</option>
                            {Object.entries(dict.closeReasons).map(([k, label]) => (
                              <option key={k} value={k}>{label}</option>
                            ))}
                          </select>
                          <button className="text-xs font-medium text-warn hover:underline">{m.closeReservation}</button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {reservations.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={10}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {newFlag === "1" && (
        <Modal title={m.newTitle} closeHref={baseUrl}>
          <form action={createReservation} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.f.project}</label>
              <SearchableSelect name="projectId" options={projectOptions} placeholder={dict.field.selectProject} className={ui.input} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={ui.label}>{m.f.siteLocation}</label>
                <input name="siteLocation" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.f.siteLocationUrl}</label>
                <input name="siteLocationUrl" className={ui.input} dir="ltr" placeholder="https://maps.google.com/…" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={ui.label}>{m.f.siteContactName}</label>
                <input name="siteContactName" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.f.siteContactPhone}</label>
                <input name="siteContactPhone" className={ui.input} dir="ltr" />
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <input type="checkbox" name="labTechnicianRequired" />
              {m.f.labTechnicianRequired}
            </label>
            <div>
              <label className={ui.label}>{dict.field.siteCode}</label>
              <select name="siteId" required className={ui.select}>
                <option value="">{dict.field.selectSite}</option>
                {sitesForPicker.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.mix}</label>
              <SearchableSelect name="mixId" options={mixOptions} placeholder={dict.field.selectMix} className={ui.input} />
              {mixes.length === 0 && <p className="mt-1 text-xs text-warn">{m.noApprovedMix}</p>}
            </div>
            <div>
              <label className={ui.label}>{m.f.cementType}</label>
              <SegmentedControl
                name="cementType"
                defaultValue=""
                options={[
                  { value: "", label: dict.field.none },
                  { value: "OPC", label: "OPC" },
                  { value: "SRC", label: "SRC" },
                ]}
              />
            </div>
            <div>
              <label className={ui.label}>{m.f.volume}</label>
              <input name="requestedVolumeM3" type="number" step="0.5" required className={ui.input} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={ui.label}>{m.f.slump}</label>
                <input name="slumpRequestedMm" type="number" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.f.slumpTolerance}</label>
                <input name="slumpToleranceMm" type="number" className={ui.input} placeholder="25" />
              </div>
              <div>
                <label className={ui.label}>{m.f.temperature}</label>
                <input name="temperatureC" type="number" step="0.5" className={ui.input} />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.f.deliveryMethod}</label>
              <SegmentedControl
                name="deliveryMethod"
                defaultValue="CHUTE"
                options={[
                  { value: "CHUTE", label: dict.deliveryMethods.CHUTE },
                  { value: "PUMP", label: dict.deliveryMethods.PUMP },
                ]}
              />
            </div>
            <div>
              <label className={ui.label}>{m.f.minPumpReachM}</label>
              <input name="minPumpReachM" type="number" step="0.5" className={ui.input} placeholder="42" />
            </div>
            <div>
              <label className={ui.label}>{m.pumpSectionTitle}</label>
              <PumpBookingRows
                pumps={pumpsRaw}
                operators={operators}
                assistants={assistants}
                labels={{
                  pumpPlaceholder: m.f.pumpPlaceholder,
                  operator: m.pumpOperator,
                  assistant: m.pumpAssistant,
                  none: dict.field.none,
                  addAnother: m.addAnotherPump,
                  remove: dict.field.delete,
                  noCrewWarning: m.noCrewWarning,
                }}
              />
            </div>
            <div>
              <label className={ui.label}>{m.f.structureType}</label>
              <select name="structureType" defaultValue="" className={ui.select}>
                <option value="">{dict.field.selectOne}</option>
                {Object.entries(dict.structureTypes).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.f.structuralElement}</label>
              <input name="structuralElement" className={ui.input} placeholder="Column C12 / Slab L3" />
            </div>
            <div>
              <label className={ui.label}>{m.f.pourStart}</label>
              <input name="pourWindowStart" type="datetime-local" defaultValue={`${selectedDate}T00:00`} required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.f.notes}</label>
              <textarea name="notes" rows={2} className={ui.input} placeholder={m.notesPlaceholder} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>
              {m.create}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
