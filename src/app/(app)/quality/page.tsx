import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createTestBatch, addLabResult, createCertificate, updateCertificate, approveWasteMemo, recordWasteMemoNote, saveCapaRecord, closeCapaRecord } from "./actions";
import { fitRegressionsByAge, predictFinalStrength, type HistoricalPair } from "@/lib/strength-prediction";
import { getActiveSiteId, plantScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";

function daysUntil(date: Date) {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// Suggestions only (datalist, not a closed enum) — the common international
// and regional ready-mix concrete standards, so issuing a certificate
// doesn't start from a blank field every time. A plant is free to type
// anything else a customer's spec actually calls for.
const STANDARD_REF_OPTIONS = [
  "ASTM C94 / C94M",
  "EN 206",
  "BS 8500-2",
  "ACI 318",
  "ES 4756-1",
  "SASO GSO 2559-1",
  "IS 456",
  "AS 1379",
] as const;
const ISSUING_BODY_OPTIONS = [
  "ASTM International",
  "European Committee for Standardization (CEN)",
  "British Standards Institution (BSI)",
  "American Concrete Institute (ACI)",
  "Egyptian Organization for Standardization and Quality (EOS)",
  "Saudi Standards, Metrology and Quality Organization (SASO)",
  "Bureau of Indian Standards (BIS)",
  "Standards Australia",
] as const;

export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ editCert?: string }>;
}) {
  const user = await requirePageAccess("quality");
  const { dict } = await getDictionary();
  const m = dict.modules.quality;
  const { editCert: editCertId } = await searchParams;
  const siteId = await getActiveSiteId(user);

  const [testBatches, sampleableTrips, employees, certificates, mixes, pendingWasteMemos, unfinishedWasteMemos, openCapaRecords, qualityUsers] = await Promise.all([
    prisma.testBatch.findMany({
      where: { ...(siteId ? { trip: tripPlantScopeWhere(siteId) } : {}) },
      orderBy: { sampleTime: "desc" },
      include: {
        trip: { include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } } },
        sampledBy: true,
        labResults: { orderBy: { ageDays: "asc" } },
      },
    }),
    prisma.trip.findMany({
      where: { status: { in: ["DISCHARGING", "CLOSED"] }, ...tripPlantScopeWhere(siteId) },
      include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } },
      orderBy: { batchTime: "desc" },
      take: 20,
    }),
    prisma.employee.findMany({ where: { role: "QUALITY_SUPERVISOR", ...plantScopeWhere(siteId) }, orderBy: { name: "asc" } }),
    // Certificates and mix designs are attached to a MixDesign, which is a
    // company-wide recipe library, not a site's own record — global, same
    // as everywhere else this appears (reservations, billing, etc).
    prisma.complianceCertificate.findMany({ include: { mix: true }, orderBy: { expiryDate: "asc" } }),
    prisma.mixDesign.findMany({ orderBy: { code: "asc" } }),
    prisma.wasteIncidentMemo.findMany({
      where: { status: "PENDING", ...(siteId ? { batchTicket: plantScopeWhere(siteId) } : {}) },
      orderBy: { createdAt: "desc" },
      include: {
        batchTicket: { include: { mix: true, reservation: { include: { project: true } } } },
        drumReturn: { include: { trip: { include: { truck: true, driver: true } } } },
      },
    }),
    // Approved before the written-finding requirement existed (see
    // approveWasteMemo/recordWasteMemoNote in ./actions) — surfaced
    // separately so Quality can backfill the finding without reopening
    // the approval itself.
    prisma.wasteIncidentMemo.findMany({
      where: { status: "APPROVED", approvalNote: null, ...(siteId ? { batchTicket: plantScopeWhere(siteId) } : {}) },
      orderBy: { approvedAt: "desc" },
      include: {
        batchTicket: { include: { mix: true, reservation: { include: { project: true } } } },
        drumReturn: { include: { trip: { include: { truck: true, driver: true } } } },
        approvedBy: true,
      },
    }),
    // Auto-opened by addLabResult on a FAIL result (see quality/actions.ts)
    // — CLOSED ones are historical record, not something needing anyone's
    // attention here.
    prisma.capaRecord.findMany({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        ...(siteId ? { labResult: { testBatch: { trip: tripPlantScopeWhere(siteId) } } } : {}),
      },
      orderBy: { createdAt: "asc" },
      include: {
        labResult: {
          include: { testBatch: { include: { trip: { include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } } } } } },
        },
        responsible: true,
      },
    }),
    prisma.user.findMany({ where: { role: { in: ["QUALITY_SUPERVISOR", "ADMIN"] } }, orderBy: { name: "asc" } }),
  ]);

  // Train the early-vs-final strength regression from every test batch that
  // already has both an early-age and a 28-day-or-later result on file —
  // this plant's own history, not a generic model.
  const historicalPairs: HistoricalPair[] = [];
  for (const tb of testBatches) {
    const finalResult = [...tb.labResults].filter((r) => r.ageDays >= 28).sort((a, b) => a.ageDays - b.ageDays)[0];
    if (!finalResult) continue;
    for (const r of tb.labResults) {
      if (r.ageDays < 28) historicalPairs.push({ ageDays: r.ageDays, earlyMpa: r.breakStrengthMpa, finalMpa: finalResult.breakStrengthMpa });
    }
  }
  const strengthFits = fitRegressionsByAge(historicalPairs);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="flex flex-col gap-4">
          {testBatches.map((tb) => {
            const hasFinalResult = tb.labResults.some((r) => r.ageDays >= 28);
            const latestEarlyResult = !hasFinalResult
              ? [...tb.labResults].sort((a, b) => b.ageDays - a.ageDays)[0]
              : undefined;
            const prediction = latestEarlyResult
              ? predictFinalStrength(latestEarlyResult.ageDays, latestEarlyResult.breakStrengthMpa, latestEarlyResult.targetStrengthMpa, strengthFits)
              : null;
            const maxTempC = tb.trip.batchTicket.reservation.temperatureC;
            const maxTempExceeded = maxTempC != null && tb.concreteTempC != null && tb.concreteTempC > maxTempC;
            return (
            <div key={tb.id} className={ui.card}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">
                    {dict.sampleTypes[tb.sampleType as keyof typeof dict.sampleTypes] ?? tb.sampleType} — {tb.trip.batchTicket.reservation.project.name}
                  </div>
                  <div className="text-xs text-ink-muted">
                    <span dir="ltr">
                      {tb.trip.batchTicket.mix.code} ({tb.trip.batchTicket.mix.grade}) · {tb.trip.batchTicket.ticketNumber} · {tb.trip.batchTicket.reservation.reservationNumber}
                    </span> · {m.sampledAt(new Date(tb.sampleTime).toLocaleString())}{" "}
                    {tb.sampledBy ? m.by(tb.sampledBy.name) : ""}
                  </div>
                  {tb.trip.batchTicket.reservation.siteLocation && (
                    <div className="text-xs text-ink-muted">{tb.trip.batchTicket.reservation.siteLocation}</div>
                  )}
                </div>
                <div className="font-mono text-xs text-ink-muted tabular" dir="ltr">
                  {tb.slumpMeasuredMm != null && <div>{m.slump(tb.slumpMeasuredMm)}</div>}
                  {tb.airContentPct != null && <div>{m.air(tb.airContentPct)}</div>}
                  {tb.concreteTempC != null && (
                    <div className={maxTempExceeded ? "font-semibold text-critical" : ""}>{tb.concreteTempC}°C</div>
                  )}
                </div>
              </div>
              {maxTempExceeded && (
                <div className="mt-2 text-xs font-medium text-critical">
                  {m.maxTempExceeded(tb.concreteTempC!, tb.trip.batchTicket.reservation.temperatureC!)}
                </div>
              )}

              <table className={`${ui.table} mt-3`}>
                <thead>
                  <tr>
                    <th className={ui.th}>{m.col.age}</th>
                    <th className={ui.th}>{m.col.breakStrength}</th>
                    <th className={ui.th}>{m.col.target}</th>
                    <th className={ui.th}>{m.col.result}</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.labResults.map((r) => (
                    <tr key={r.id}>
                      <td className={`${ui.td} font-mono tabular`}>{r.ageDays}d</td>
                      <td className={`${ui.td} font-mono tabular`}>{r.breakStrengthMpa} MPa</td>
                      <td className={`${ui.td} font-mono tabular`}>{r.targetStrengthMpa} MPa</td>
                      <td className={ui.td}>
                        <span
                          className={`${ui.chip} ${r.passFail === "PASS" ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}
                        >
                          {dict.status[r.passFail as keyof typeof dict.status] ?? r.passFail}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {tb.labResults.length === 0 && (
                    <tr>
                      <td className={ui.td} colSpan={4}>
                        <span className="text-ink-muted">{m.emptyResults}</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              {prediction && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-alt px-3 py-2 text-sm">
                  <span className={`${ui.chip} ${prediction.atRisk ? "bg-critical-soft text-critical" : "bg-good-soft text-good"}`}>
                    {prediction.atRisk ? m.atRisk : m.onTrack}
                  </span>
                  <span>
                    {m.predictedStrength(prediction.predictedFinalMpa)}
                    {" — "}
                    {prediction.method.kind === "REGRESSION" ? m.methodRegression(prediction.method.sampleCount, prediction.method.rSquared) : m.methodDefault}
                  </span>
                </div>
              )}

              <form action={addLabResult} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="testBatchId" value={tb.id} />
                <div>
                  <label className={ui.label}>{m.fResult.ageDays}</label>
                  <input name="ageDays" type="number" defaultValue={28} className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className={ui.label}>{m.fResult.breakStrength}</label>
                  <input name="breakStrengthMpa" type="number" step="0.1" required className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className={ui.label}>{m.fResult.targetStrength}</label>
                  <input name="targetStrengthMpa" type="number" step="0.1" required className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">
                  {m.recordResult}
                </button>
              </form>
            </div>
            );
          })}
          {testBatches.length === 0 && (
            <div className={`${ui.card} text-sm text-ink-muted`}>{m.emptyBatches}</div>
          )}
        </div>

        <form action={createTestBatch} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.sampleTitle}</h2>
          <div>
            <label className={ui.label}>{m.fSample.trip}</label>
            <select name="tripId" required className={ui.select}>
              <option value="">{dict.field.selectTrip}</option>
              {sampleableTrips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.batchTicket.ticketNumber} · {t.batchTicket.reservation.reservationNumber} — {t.batchTicket.reservation.project.name} · {t.batchTicket.mix.code} ({t.batchTicket.mix.grade}){t.batchTicket.reservation.siteLocation ? ` · ${t.batchTicket.reservation.siteLocation}` : ""}
                </option>
              ))}
            </select>
            {sampleableTrips.length === 0 && <p className="mt-1 text-xs text-warn">{m.noTripsAvailable}</p>}
          </div>
          <div>
            <label className={ui.label}>{m.fSample.sampleType}</label>
            <select name="sampleType" className={ui.select}>
              <option value="CYLINDER">{dict.sampleTypes.CYLINDER}</option>
              <option value="CUBE">{dict.sampleTypes.CUBE}</option>
              <option value="SLUMP_ONLY">{dict.sampleTypes.SLUMP_ONLY}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fSample.sampledBy}</label>
            <select name="sampledById" className={ui.select}>
              <option value="">{dict.field.unassigned}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fSample.slump}</label>
            <input name="slumpMeasuredMm" type="number" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.fSample.air}</label>
            <input name="airContentPct" type="number" step="0.1" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.fSample.temp}</label>
            <input name="concreteTempC" type="number" step="0.1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.logSample}
          </button>
        </form>
      </div>

      <div className={`${ui.card} ${pendingWasteMemos.length > 0 ? "border-warn/40" : ""}`}>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.wasteMemos.title}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.wasteMemos.intro}</p>
        <div className="flex flex-col gap-3">
          {pendingWasteMemos.map((memo) => (
            <form key={memo.id} action={approveWasteMemo} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <input type="hidden" name="id" value={memo.id} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <Link href={`/production/${memo.batchTicketId}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                  {memo.batchTicket.ticketNumber}
                </Link>
                <span className="font-mono text-xs text-ink-muted" dir="ltr">{memo.batchTicket.reservation.reservationNumber}</span>
                <span>{memo.batchTicket.reservation.project.name}</span>
                <span className="font-mono text-xs" dir="ltr">{memo.batchTicket.mix.code} ({memo.batchTicket.mix.grade})</span>
                <span className="font-mono text-xs" dir="ltr">{memo.drumReturn.trip.truck.code}</span>
                <span className="font-mono tabular">{memo.wastedVolumeM3} m³</span>
                <span>{dict.returnReasons[memo.reasonCode as keyof typeof dict.returnReasons] ?? memo.reasonCode}</span>
                <span className="font-mono text-xs tabular text-ink-muted">{new Date(memo.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className={ui.label}>{m.wasteMemos.noteLabel}</label>
                  <textarea
                    name="approvalNote"
                    required
                    rows={2}
                    placeholder={m.wasteMemos.notePlaceholder}
                    className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <button className="rounded-md border border-good bg-good-soft px-3 py-1.5 text-xs font-medium text-good hover:opacity-80">
                  {m.wasteMemos.approve}
                </button>
              </div>
            </form>
          ))}
          {pendingWasteMemos.length === 0 && <p className="text-sm text-ink-muted">{m.wasteMemos.empty}</p>}
        </div>
      </div>

      {unfinishedWasteMemos.length > 0 && (
        <div className={`${ui.card} border-warn/40`}>
          <h2 className="mb-1 font-display text-lg font-semibold">{m.wasteMemos.backfillTitle}</h2>
          <p className="mb-3 text-sm text-ink-muted">{m.wasteMemos.backfillIntro}</p>
          <div className="flex flex-col gap-3">
            {unfinishedWasteMemos.map((memo) => (
              <form key={memo.id} action={recordWasteMemoNote} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <input type="hidden" name="id" value={memo.id} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <Link href={`/production/${memo.batchTicketId}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                    {memo.batchTicket.ticketNumber}
                  </Link>
                  <span className="font-mono text-xs text-ink-muted" dir="ltr">{memo.batchTicket.reservation.reservationNumber}</span>
                  <span>{memo.batchTicket.reservation.project.name}</span>
                  <span className="font-mono tabular">{memo.wastedVolumeM3} m³</span>
                  <span className="text-xs text-ink-muted">
                    {memo.approvedBy ? dict.modules.production.detail.wasteMemoApproved(memo.approvedBy.name, new Date(memo.approvedAt!).toLocaleDateString()) : ""}
                  </span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className={ui.label}>{m.wasteMemos.noteLabel}</label>
                    <textarea
                      name="approvalNote"
                      required
                      rows={2}
                      placeholder={m.wasteMemos.notePlaceholder}
                      className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                    />
                  </div>
                  <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
                    {m.wasteMemos.saveNote}
                  </button>
                </div>
              </form>
            ))}
          </div>
        </div>
      )}

      {openCapaRecords.length > 0 && (
        <div className={`${ui.card} border-warn/40`}>
          <h2 className="mb-1 font-display text-lg font-semibold">{m.capa.title}</h2>
          <p className="mb-3 text-sm text-ink-muted">{m.capa.intro}</p>
          <div className="flex flex-col gap-3">
            {openCapaRecords.map((capa) => {
              const tb = capa.labResult.testBatch;
              const canClose = !!(capa.rootCause && capa.correctiveAction);
              return (
                <form key={capa.id} action={saveCapaRecord} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <input type="hidden" name="id" value={capa.id} />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="font-mono text-xs font-medium text-accent-strong" dir="ltr">{capa.capaNumber}</span>
                    <Link href={`/production/${tb.trip.batchTicket.id}`} className="font-mono text-xs text-accent-strong hover:underline" dir="ltr">
                      {tb.trip.batchTicket.ticketNumber}
                    </Link>
                    <span>{tb.trip.batchTicket.reservation.project.name}</span>
                    <span className="font-mono text-xs" dir="ltr">{tb.trip.batchTicket.mix.code} ({tb.trip.batchTicket.mix.grade})</span>
                    <span className="font-mono tabular text-critical">{capa.labResult.breakStrengthMpa} / {capa.labResult.targetStrengthMpa} MPa @ {capa.labResult.ageDays}d</span>
                    <span className={`${ui.chip} ${capa.status === "OPEN" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"}`}>
                      {m.capa.statusLabel[capa.status as keyof typeof m.capa.statusLabel] ?? capa.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={ui.label}>{m.capa.f.rootCause}</label>
                      <textarea name="rootCause" defaultValue={capa.rootCause ?? ""} rows={2} className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className={ui.label}>{m.capa.f.correctiveAction}</label>
                      <textarea name="correctiveAction" defaultValue={capa.correctiveAction ?? ""} rows={2} className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className={ui.label}>{m.capa.f.preventiveAction}</label>
                      <textarea name="preventiveAction" defaultValue={capa.preventiveAction ?? ""} rows={2} className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                    </div>
                    <div className="flex flex-col gap-2">
                      <div>
                        <label className={ui.label}>{m.capa.f.responsibleId}</label>
                        <select name="responsibleId" defaultValue={capa.responsibleId ?? ""} className={`${ui.select} w-full`}>
                          <option value="">{dict.field.none}</option>
                          {qualityUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className={ui.label}>{m.capa.f.dueDate}</label>
                        <input name="dueDate" type="date" defaultValue={capa.dueDate ? new Date(capa.dueDate).toISOString().slice(0, 10) : ""} className={`${ui.input} w-full`} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">{m.capa.save}</button>
                    {canClose && (
                      <button formAction={closeCapaRecord} className="rounded-md border border-good bg-good-soft px-3 py-1.5 text-xs font-medium text-good hover:opacity-80">
                        {m.capa.close}
                      </button>
                    )}
                    {!canClose && <span className="text-xs text-ink-muted">{m.capa.closeHint}</span>}
                  </div>
                </form>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.certsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colCerts.mix}</th>
                <th className={ui.th}>{m.colCerts.standard}</th>
                <th className={ui.th}>{m.colCerts.issuingBody}</th>
                <th className={ui.th}>{m.colCerts.expiry}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {certificates.map((c) => {
                const remaining = daysUntil(c.expiryDate);
                if (editCertId === c.id) {
                  return (
                    <tr key={c.id}>
                      <td className={ui.td} colSpan={5}>
                        <form action={updateCertificate} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <div>
                            <label className={ui.label}>{m.fCert.mix}</label>
                            <select name="mixId" defaultValue={c.mixId} required className={`${ui.select} w-36`}>
                              {mixes.map((mx) => (
                                <option key={mx.id} value={mx.id}>{mx.code}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{m.fCert.standardRef}</label>
                            <input name="standardRef" defaultValue={c.standardRef} required list="standardRefOptions" className={`${ui.input} w-32`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.fCert.issuingBody}</label>
                            <input name="issuingBody" defaultValue={c.issuingBody} required list="issuingBodyOptions" className={`${ui.input} w-44`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.fCert.issuedDate}</label>
                            <input name="issuedDate" type="date" defaultValue={new Date(c.issuedDate).toISOString().slice(0, 10)} required className={`${ui.input} w-36`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.fCert.expiryDate}</label>
                            <input name="expiryDate" type="date" defaultValue={new Date(c.expiryDate).toISOString().slice(0, 10)} required className={`${ui.input} w-36`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.fCert.documentUrl}</label>
                            <input name="documentUrl" defaultValue={c.documentUrl ?? ""} className={`${ui.input} w-40`} dir="ltr" />
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/quality" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={c.id}>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{c.mix.code}</td>
                    <td className={ui.td}>{c.standardRef}</td>
                    <td className={ui.td}>{c.issuingBody}</td>
                    <td className={ui.td}>
                      {new Date(c.expiryDate).toLocaleDateString()}
                      {remaining < 0 && <span className={`${ui.chip} bg-critical-soft text-critical ms-2`}>{m.expired}</span>}
                      {remaining >= 0 && remaining <= 60 && (
                        <span className={`${ui.chip} bg-warn-soft text-warn ms-2`}>{m.daysLeft(remaining)}</span>
                      )}
                    </td>
                    <td className={ui.td}>
                      <Link href={`/quality?editCert=${c.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {certificates.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.emptyCerts}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createCertificate} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newCertTitle}</h2>
          <div>
            <label className={ui.label}>{m.fCert.mix}</label>
            <select name="mixId" required className={ui.select}>
              <option value="">{dict.field.selectMix}</option>
              {mixes.map((mx) => (
                <option key={mx.id} value={mx.id}>
                  {mx.code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fCert.standardRef}</label>
            <input name="standardRef" required list="standardRefOptions" className={ui.input} placeholder="ES 4756-1 / EN 206" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.fCert.issuingBody}</label>
            <input name="issuingBody" required list="issuingBodyOptions" className={ui.input} placeholder="Egyptian Organization for Standardization" />
          </div>
          <div>
            <label className={ui.label}>{m.fCert.issuedDate}</label>
            <input name="issuedDate" type="date" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.fCert.expiryDate}</label>
            <input name="expiryDate" type="date" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.fCert.documentUrl}</label>
            <input name="documentUrl" className={ui.input} placeholder="https://…" dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.addCert}
          </button>
        </form>
      </div>

      <datalist id="standardRefOptions">
        {STANDARD_REF_OPTIONS.map((ref) => <option key={ref} value={ref} />)}
      </datalist>
      <datalist id="issuingBodyOptions">
        {ISSUING_BODY_OPTIONS.map((body) => <option key={body} value={body} />)}
      </datalist>
    </div>
  );
}
