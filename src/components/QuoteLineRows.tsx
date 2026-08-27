"use client";

import { useState } from "react";

type CustomerOption = { id: string; code: string | null; legalName: string };
type MixOption = { id: string; code: string; grade: string };
type PriceEntry = { customerId: string; mixId: string; pricePerM3: number };

// Owns the customer picker AND the repeatable mix/volume/price rows as one
// self-contained interactive unit within the larger New Quote form — same
// shape as PumpBookingRows owning pumpId+crew while Reservation's other
// fields (project, site, dates) stay plain server-rendered inputs in the
// surrounding form. Each row posts mixId[]/estimatedVolumeM3[]/unitPrice[]
// under repeated field names, read back server-side via formData.getAll()
// as parallel arrays (see createQuote). Picking a customer or a mix re-keys
// the price input (the same "remount to refresh defaultValue" trick
// PumpBookingRows' operator/assistant selects use) so it defaults to that
// customer+mix's PriceListEntry rate when one exists — freely editable
// after, never locked.
export function QuoteLineRows({
  customers,
  mixes,
  priceEntries,
  labels,
}: {
  customers: CustomerOption[];
  mixes: MixOption[];
  priceEntries: PriceEntry[];
  labels: {
    customer: string;
    customerPlaceholder: string;
    mixPlaceholder: string;
    volume: string;
    unitPrice: string;
    addAnother: string;
    remove: string;
    noPriceOnFile: string;
  };
}) {
  const [customerId, setCustomerId] = useState("");
  const [rows, setRows] = useState<number[]>([0]);
  const [nextId, setNextId] = useState(1);
  const [selectedMix, setSelectedMix] = useState<Record<number, string>>({});

  function addRow() {
    setRows((r) => [...r, nextId]);
    setNextId((n) => n + 1);
  }
  function removeRow(id: number) {
    setRows((r) => r.filter((x) => x !== id));
  }
  function suggestedPrice(mixId: string): number | null {
    if (!customerId || !mixId) return null;
    return priceEntries.find((p) => p.customerId === customerId && p.mixId === mixId)?.pricePerM3 ?? null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={"block text-xs font-medium text-ink-muted mb-1"}>{labels.customer}</label>
        <select
          name="customerId"
          required
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="" disabled>{labels.customerPlaceholder}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code ? `${c.code} — ${c.legalName}` : c.legalName}
            </option>
          ))}
        </select>
      </div>

      {rows.map((id) => {
        const mixId = selectedMix[id];
        const price = mixId ? suggestedPrice(mixId) : null;
        return (
          <div key={id} className="rounded-md border border-border p-3">
            <div className="grid grid-cols-3 gap-2">
              <select
                name="mixId"
                defaultValue=""
                onChange={(e) => setSelectedMix((s) => ({ ...s, [id]: e.target.value }))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                <option value="" disabled>{labels.mixPlaceholder}</option>
                {mixes.map((mx) => (
                  <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
                ))}
              </select>
              <input
                name="estimatedVolumeM3"
                type="number"
                step="0.1"
                min="0.1"
                placeholder={labels.volume}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              />
              <input
                key={`price-${customerId}-${mixId ?? id}`}
                name="unitPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={price ?? ""}
                placeholder={labels.unitPrice}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              />
            </div>
            {mixId && customerId && price === null && <p className="mt-1 text-xs text-warn">{labels.noPriceOnFile}</p>}
            {rows.length > 1 && (
              <button type="button" onClick={() => removeRow(id)} className="mt-1 text-xs font-medium text-critical hover:underline">
                {labels.remove}
              </button>
            )}
          </div>
        );
      })}
      <button type="button" onClick={addRow} className="text-sm font-medium text-accent-strong hover:underline">
        + {labels.addAnother}
      </button>
    </div>
  );
}
