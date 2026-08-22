"use client";

import { useState } from "react";

type Option = { value: string; label: string };
type EquipmentOption = Option & { defaults: Record<string, string> };

// Pairs one equipment <select> (truck, or pump) with one or more dependent
// person <select>s (driver — or operator + assistant for a pump). Picking
// the equipment pre-fills each dependent from that equipment's registered
// default (Truck.defaultDriverId / Pump.defaultOperatorId /
// Pump.defaultAssistantId) — but every dependent stays a fully independent,
// freely-editable <select> afterward, so a default is only ever a starting
// point, never a lock.
export function EquipmentAssignPicker({
  equipment,
  dependents,
}: {
  equipment: {
    name: string;
    label: string;
    placeholder: string;
    required?: boolean;
    className: string;
    hint?: string;
    defaultValue?: string;
    options: EquipmentOption[];
  };
  dependents: {
    key: string;
    name: string;
    label: string;
    placeholder: string;
    required?: boolean;
    className: string;
    defaultValue?: string;
    options: Option[];
  }[];
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(dependents.map((d) => [d.key, d.defaultValue ?? ""])),
  );

  function handleEquipmentChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = equipment.options.find((o) => o.value === e.target.value);
    setValues(Object.fromEntries(dependents.map((d) => [d.key, selected?.defaults[d.key] ?? ""])));
  }

  return (
    <>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-muted">{equipment.label}</label>
        <select name={equipment.name} required={equipment.required} defaultValue={equipment.defaultValue ?? ""} onChange={handleEquipmentChange} className={equipment.className}>
          <option value="">{equipment.placeholder}</option>
          {equipment.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {equipment.hint && <p className="mt-1 text-xs text-ink-muted">{equipment.hint}</p>}
      </div>
      {dependents.map((d) => (
        <div key={d.key}>
          <label className="mb-1 block text-xs font-medium text-ink-muted">{d.label}</label>
          <select
            name={d.name}
            required={d.required}
            value={values[d.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
            className={d.className}
          >
            <option value="">{d.placeholder}</option>
            {d.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
    </>
  );
}
