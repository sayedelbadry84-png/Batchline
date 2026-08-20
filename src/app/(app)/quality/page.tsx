import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createTestBatch, addLabResult, createCertificate } from "./actions";

function daysUntil(date: Date) {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

export default async function QualityPage() {
  await requirePageAccess("quality");

  const [testBatches, sampleableTrips, employees, certificates, mixes] = await Promise.all([
    prisma.testBatch.findMany({
      orderBy: { sampleTime: "desc" },
      include: {
        trip: { include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } } },
        sampledBy: true,
        labResults: { orderBy: { ageDays: "asc" } },
      },
    }),
    prisma.trip.findMany({
      where: { status: { in: ["DISCHARGING", "CLOSED"] } },
      include: { batchTicket: { include: { reservation: { include: { project: true } } } } },
      orderBy: { batchTime: "desc" },
      take: 20,
    }),
    prisma.employee.findMany({ where: { role: "QUALITY_SUPERVISOR" }, orderBy: { name: "asc" } }),
    prisma.complianceCertificate.findMany({ include: { mix: true }, orderBy: { expiryDate: "asc" } }),
    prisma.mixDesign.findMany({ orderBy: { code: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Modules — Quality &amp; Compliance</div>
        <h1 className={ui.h1}>Test batches, lab results &amp; certificates</h1>
        <p className={ui.intro}>
          Every cylinder traces back to one trip, one truck, one driver, and
          one batch ticket — a strength failure can be chased to a specific
          load without cross-referencing paperwork.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="flex flex-col gap-4">
          {testBatches.map((tb) => (
            <div key={tb.id} className={ui.card}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">
                    {tb.sampleType} — {tb.trip.batchTicket.reservation.project.name}
                  </div>
                  <div className="text-xs text-ink-muted">
                    {tb.trip.batchTicket.mix.code} · {tb.trip.batchTicket.ticketNumber} · sampled{" "}
                    {new Date(tb.sampleTime).toLocaleString()} {tb.sampledBy ? `by ${tb.sampledBy.name}` : ""}
                  </div>
                </div>
                <div className="font-mono text-xs text-ink-muted tabular">
                  {tb.slumpMeasuredMm != null && <div>slump {tb.slumpMeasuredMm}mm</div>}
                  {tb.airContentPct != null && <div>air {tb.airContentPct}%</div>}
                  {tb.concreteTempC != null && <div>{tb.concreteTempC}°C</div>}
                </div>
              </div>

              <table className={`${ui.table} mt-3`}>
                <thead>
                  <tr>
                    <th className={ui.th}>Age</th>
                    <th className={ui.th}>Break strength</th>
                    <th className={ui.th}>Target</th>
                    <th className={ui.th}>Result</th>
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
                          {r.passFail}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {tb.labResults.length === 0 && (
                    <tr>
                      <td className={ui.td} colSpan={4}>
                        <span className="text-ink-muted">No break results yet.</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <form action={addLabResult} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="testBatchId" value={tb.id} />
                <div>
                  <label className={ui.label}>Age (days)</label>
                  <input name="ageDays" type="number" defaultValue={28} className="w-20 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className={ui.label}>Break strength (MPa)</label>
                  <input name="breakStrengthMpa" type="number" step="0.1" required className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className={ui.label}>Target strength (MPa)</label>
                  <input name="targetStrengthMpa" type="number" step="0.1" required className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                </div>
                <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">
                  Record result
                </button>
              </form>
            </div>
          ))}
          {testBatches.length === 0 && (
            <div className={`${ui.card} text-sm text-ink-muted`}>No test batches sampled yet.</div>
          )}
        </div>

        <form action={createTestBatch} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">Sample a test batch</h2>
          <div>
            <label className={ui.label}>Trip</label>
            <select name="tripId" required className={ui.select}>
              <option value="">Select trip…</option>
              {sampleableTrips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.batchTicket.ticketNumber} — {t.batchTicket.reservation.project.name}
                </option>
              ))}
            </select>
            {sampleableTrips.length === 0 && (
              <p className="mt-1 text-xs text-warn">No trips discharging or closed yet.</p>
            )}
          </div>
          <div>
            <label className={ui.label}>Sample type</label>
            <select name="sampleType" className={ui.select}>
              <option value="CYLINDER">Cylinder</option>
              <option value="CUBE">Cube</option>
              <option value="SLUMP_ONLY">Slump only</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>Sampled by</label>
            <select name="sampledById" className={ui.select}>
              <option value="">Unassigned</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Slump measured (mm)</label>
            <input name="slumpMeasuredMm" type="number" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Air content (%)</label>
            <input name="airContentPct" type="number" step="0.1" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Concrete temp (°C)</label>
            <input name="concreteTempC" type="number" step="0.1" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Log sample
          </button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">Compliance certificates</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Mix</th>
                <th className={ui.th}>Standard</th>
                <th className={ui.th}>Issuing body</th>
                <th className={ui.th}>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {certificates.map((c) => {
                const remaining = daysUntil(c.expiryDate);
                return (
                  <tr key={c.id}>
                    <td className={`${ui.td} font-mono text-xs`}>{c.mix.code}</td>
                    <td className={ui.td}>{c.standardRef}</td>
                    <td className={ui.td}>{c.issuingBody}</td>
                    <td className={ui.td}>
                      {new Date(c.expiryDate).toLocaleDateString()}
                      {remaining < 0 && <span className={`${ui.chip} bg-critical-soft text-critical ms-2`}>expired</span>}
                      {remaining >= 0 && remaining <= 60 && (
                        <span className={`${ui.chip} bg-warn-soft text-warn ms-2`}>{remaining}d left</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {certificates.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">No certificates on file.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createCertificate} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New certificate</h2>
          <div>
            <label className={ui.label}>Mix design</label>
            <select name="mixId" required className={ui.select}>
              <option value="">Select mix…</option>
              {mixes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Standard reference</label>
            <input name="standardRef" required className={ui.input} placeholder="ES 4756-1 / EN 206" />
          </div>
          <div>
            <label className={ui.label}>Issuing body</label>
            <input name="issuingBody" required className={ui.input} placeholder="Egyptian Organization for Standardization" />
          </div>
          <div>
            <label className={ui.label}>Issued date</label>
            <input name="issuedDate" type="date" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Expiry date</label>
            <input name="expiryDate" type="date" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Document link (optional)</label>
            <input name="documentUrl" className={ui.input} placeholder="https://…" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add certificate
          </button>
        </form>
      </div>
    </div>
  );
}
