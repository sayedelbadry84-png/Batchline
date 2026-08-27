"use client";

import { useState } from "react";

type SupplierOption = { id: string; name: string };
type MaterialOption = { id: string; name: string; type: string };
type ContractEntry = { supplierId: string; materialId: string; pricePerUnit: number | null };

// Owns the supplier picker AND the repeatable material/quantity/price line
// rows for the New Purchase Order form as one self-contained interactive
// unit — same shape as QuoteLineRows in the Sales module (itself following
// PumpBookingRows' precedent): picking a supplier or a material re-keys the
// price input so it defaults to that pair's SupplierContract.pricePerUnit
// when one exists, freely editable after, never locked.
export function PurchaseOrderLineRows({
  suppliers,
  materials,
  contracts,
  labels,
}: {
  suppliers: SupplierOption[];
  materials: MaterialOption[];
  contracts: ContractEntry[];
  labels: {
    supplier: string;
    supplierPlaceholder: string;
    materialPlaceholder: string;
    orderedMass: string;
    unitPrice: string;
    addAnother: string;
    remove: string;
    noPriceOnFile: string;
  };
}) {
  const [supplierId, setSupplierId] = useState("");
  const [rows, setRows] = useState<number[]>([0]);
  const [nextId, setNextId] = useState(1);
  const [selectedMaterial, setSelectedMaterial] = useState<Record<number, string>>({});

  function addRow() {
    setRows((r) => [...r, nextId]);
    setNextId((n) => n + 1);
  }
  function removeRow(id: number) {
    setRows((r) => r.filter((x) => x !== id));
  }
  function suggestedPrice(materialId: string): number | null {
    if (!supplierId || !materialId) return null;
    return contracts.find((c) => c.supplierId === supplierId && c.materialId === materialId)?.pricePerUnit ?? null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={"block text-xs font-medium text-ink-muted mb-1"}>{labels.supplier}</label>
        <select
          name="supplierId"
          required
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="" disabled>{labels.supplierPlaceholder}</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {rows.map((id) => {
        const materialId = selectedMaterial[id];
        const price = materialId ? suggestedPrice(materialId) : null;
        return (
          <div key={id} className="rounded-md border border-border p-3">
            <div className="grid grid-cols-3 gap-2">
              <select
                name="materialId"
                defaultValue=""
                onChange={(e) => setSelectedMaterial((s) => ({ ...s, [id]: e.target.value }))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                <option value="" disabled>{labels.materialPlaceholder}</option>
                {materials.map((mt) => (
                  <option key={mt.id} value={mt.id}>{mt.name} ({mt.type})</option>
                ))}
              </select>
              <input
                name="orderedMassKg"
                type="number"
                step="1"
                min="1"
                placeholder={labels.orderedMass}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              />
              <input
                key={`price-${supplierId}-${materialId ?? id}`}
                name="unitPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={price ?? ""}
                placeholder={labels.unitPrice}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              />
            </div>
            {materialId && supplierId && price === null && <p className="mt-1 text-xs text-warn">{labels.noPriceOnFile}</p>}
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
