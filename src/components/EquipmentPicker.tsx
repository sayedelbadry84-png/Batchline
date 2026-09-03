"use client";

import { useState } from "react";

type EquipmentOption = { type: string; id: string; label: string };

// A single dropdown standing in for three form fields at once
// (equipmentType/equipmentId/equipmentLabel) — MaintenanceTicket/
// MaintenancePlan have no FK to any one equipment table (see the schema
// section comment), so the server action needs all three written
// verbatim. Encoding "type::id" as the option value and keeping the
// matching label in local state avoids a second round-trip to look the
// label up server-side.
//
// initialSelection seeds the starting value (e.g.
// warehouses/MaintenanceOrderAndEquipmentFields sets it from whatever
// equipment a picked work order is already against) — the CALLER is
// responsible for changing this component's `key` when that source
// changes, which remounts it with the new initial value. That's the
// React-recommended way to reset state from a prop without an effect;
// see MaintenanceOrderAndEquipmentFields for how the key is derived.
// Once mounted, the user can freely override the selection by hand.
export function EquipmentPicker({
  options,
  placeholder,
  typeLabels,
  required = true,
  initialSelection,
}: {
  options: EquipmentOption[];
  placeholder: string;
  typeLabels: Record<string, string>;
  required?: boolean;
  initialSelection?: { type: string; id: string } | null;
}) {
  const [selected, setSelected] = useState<EquipmentOption | null>(() => {
    if (!initialSelection) return null;
    return options.find((o) => o.type === initialSelection.type && o.id === initialSelection.id) ?? null;
  });

  return (
    <>
      <select
        required={required}
        value={selected ? `${selected.type}::${selected.id}` : ""}
        onChange={(e) => {
          const [type, id] = e.target.value.split("::");
          const opt = options.find((o) => o.type === type && o.id === id) ?? null;
          setSelected(opt);
        }}
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
      >
        <option value="" disabled>{placeholder}</option>
        {options.map((o) => (
          <option key={`${o.type}::${o.id}`} value={`${o.type}::${o.id}`}>
            {typeLabels[o.type] ?? o.type} — {o.label}
          </option>
        ))}
      </select>
      <input type="hidden" name="equipmentType" value={selected?.type ?? ""} />
      <input type="hidden" name="equipmentId" value={selected?.id ?? ""} />
      <input type="hidden" name="equipmentLabel" value={selected?.label ?? ""} />
    </>
  );
}
