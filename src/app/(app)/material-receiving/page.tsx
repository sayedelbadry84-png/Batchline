import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { createReceipt, setQcStatus } from "./actions";

const qcChip: Record<string, string> = {
  PENDING: "bg-surface-alt text-ink-muted",
  PASSED: "bg-good-soft text-good",
  HELD: "bg-warn-soft text-warn",
  REJECTED: "bg-critical-soft text-critical",
};

export default async function MaterialReceivingPage() {
  const [receipts, plants, suppliers, materials, silos, hoppers] = await Promise.all([
    prisma.materialReceipt.findMany({
      orderBy: { receivedAt: "desc" },
      include: { supplier: true, material: true, destinationSilo: true, destinationHopper: true },
    }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
    prisma.silo.findMany({ orderBy: { name: "asc" } }),
    prisma.hopper.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 04 — Material Receiving</div>
        <h1 className={ui.h1}>Incoming deliveries</h1>
        <p className={ui.intro}>
          Weighbridge-verified receipt against a purchase order. Net weight
          is computed from gross and tare, never entered directly — nothing
          reaches silo or hopper inventory until quality control passes it.
        </p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Received</th>
              <th className={ui.th}>Supplier / material</th>
              <th className={ui.th}>PO</th>
              <th className={ui.th}>Net weight</th>
              <th className={ui.th}>Variance vs PO</th>
              <th className={ui.th}>Destination</th>
              <th className={ui.th}>QC status</th>
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => {
              const variancePct = r.orderedMassKg ? ((r.netWeightKg - r.orderedMassKg) / r.orderedMassKg) * 100 : null;
              return (
                <tr key={r.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(r.receivedAt).toLocaleString()}</td>
                  <td className={ui.td}>
                    {r.supplier.name}
                    <div className="text-xs text-ink-muted">{r.material.name}</div>
                  </td>
                  <td className={`${ui.td} font-mono text-xs`}>{r.poNumber || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {r.netWeightKg.toFixed(0)} kg
                    {r.moisturePct != null && <div className="text-xs text-ink-faint">moisture {r.moisturePct}%</div>}
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>
                    {variancePct != null ? (
                      <span className={Math.abs(variancePct) > 2 ? "text-critical" : "text-good"}>
                        {variancePct > 0 ? "+" : ""}
                        {variancePct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-ink-faint">no PO qty</span>
                    )}
                  </td>
                  <td className={ui.td}>{r.destinationSilo?.name || r.destinationHopper?.name || "—"}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${qcChip[r.qcStatus] ?? ""}`}>{r.qcStatus}</span>
                  </td>
                  <td className={ui.td}>
                    {r.qcStatus !== "PASSED" && r.qcStatus !== "REJECTED" && (
                      <div className="flex gap-1">
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="PASSED" />
                          <button className="rounded-md border border-good bg-good-soft px-2 py-1 text-xs text-good hover:opacity-80">
                            Pass
                          </button>
                        </form>
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="HELD" />
                          <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                            Hold
                          </button>
                        </form>
                        <form action={setQcStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="REJECTED" />
                          <button className="rounded-md border border-critical bg-critical-soft px-2 py-1 text-xs text-critical hover:opacity-80">
                            Reject
                          </button>
                        </form>
                      </div>
                    )}
                    {r.qcStatus === "PASSED" && (
                      <span className="text-xs text-ink-faint">posted to inventory</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {receipts.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={8}>
                  <span className="text-ink-muted">No deliveries received yet.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form action={createReceipt} className={`${ui.card} grid grid-cols-3 gap-4`}>
        <h2 className="col-span-3 font-display text-lg font-semibold">Capture weighbridge ticket</h2>
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
          <label className={ui.label}>Supplier</label>
          <select name="supplierId" required className={ui.select}>
            <option value="">Select supplier…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>Material</label>
          <select name="materialId" required className={ui.select}>
            <option value="">Select material…</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>PO number</label>
          <input name="poNumber" className={ui.input} placeholder="PO-4471" />
        </div>
        <div>
          <label className={ui.label}>Ordered quantity (kg)</label>
          <input name="orderedMassKg" type="number" step="1" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>Moisture at receipt (%)</label>
          <input name="moisturePct" type="number" step="0.1" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>Gross weight (kg)</label>
          <input name="grossWeightKg" type="number" step="1" required className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>Tare weight (kg)</label>
          <input name="tareWeightKg" type="number" step="1" required className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>Destination silo</label>
          <select name="destinationSiloId" className={ui.select}>
            <option value="">None</option>
            {silos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.materialType})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>Destination hopper</label>
          <select name="destinationHopperId" className={ui.select}>
            <option value="">None</option>
            {hoppers.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.aggregateType})
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={`${ui.button} col-span-3 justify-self-start`}>
          Capture receipt
        </button>
      </form>
    </div>
  );
}
