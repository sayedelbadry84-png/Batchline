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
export function EquipmentPicker({
  options,
  placeholder,
  typeLabels,
}: {
  options: EquipmentOption[];
  placeholder: string;
  typeLabels: Record<string, string>;
}) {
  const [selected, setSelected] = useState<EquipmentOption | null>(null);

  return (
    <>
      <select
        required
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
