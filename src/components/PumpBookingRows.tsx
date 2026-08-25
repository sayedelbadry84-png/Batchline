"use client";

import { useState } from "react";

type PumpOption = { id: string; code: string; reachM: number | null; defaultOperatorId: string | null; defaultAssistantId: string | null };
type CrewOption = { id: string; name: string };

// Repeatable pump-reservation rows for the New Booking form — each row
// posts pumpId/pumpOperatorId/pumpAssistantId under the same field names,
// read back server-side via formData.getAll() as parallel arrays (see
// createReservation). Selecting a pump re-keys its operator/assistant
// <select>s (same "remount to refresh defaultValue" trick SitePlantSelect
// already uses) so they default to that pump's own registered crew, with
// a warning when it has none — mirrors RhinoMaster's own inline warning.
export function PumpBookingRows({
  pumps,
  operators,
  assistants,
  labels,
}: {
  pumps: PumpOption[];
  operators: CrewOption[];
  assistants: CrewOption[];
  labels: {
    pumpPlaceholder: string;
    operator: string;
    assistant: string;
    none: string;
    addAnother: string;
    remove: string;
    noCrewWarning: string;
  };
}) {
  const [rows, setRows] = useState<number[]>([0]);
  const [nextId, setNextId] = useState(1);
  const [selectedPump, setSelectedPump] = useState<Record<number, string>>({});

  function addRow() {
    setRows((r) => [...r, nextId]);
    setNextId((n) => n + 1);
  }
  function removeRow(id: number) {
    setRows((r) => r.filter((x) => x !== id));
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.map((id) => {
        const pump = pumps.find((p) => p.id === selectedPump[id]);
        const noCrew = pump != null && !pump.defaultOperatorId && !pump.defaultAssistantId;
        return (
          <div key={id} className="rounded-md border border-border p-3">
            <div className="grid grid-cols-3 gap-2">
              <select
                name="pumpId"
                defaultValue=""
                onChange={(e) => setSelectedPump((s) => ({ ...s, [id]: e.target.value }))}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                <option value="" disabled>
                  {labels.pumpPlaceholder}
                </option>
                {pumps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}
                    {p.reachM != null ? ` · ${p.reachM}m` : ""}
                  </option>
                ))}
              </select>
              <select
                key={`op-${pump?.id ?? id}`}
                name="pumpOperatorId"
                defaultValue={pump?.defaultOperatorId ?? ""}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                <option value="">{labels.none}</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <select
                key={`as-${pump?.id ?? id}`}
                name="pumpAssistantId"
                defaultValue={pump?.defaultAssistantId ?? ""}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
              >
                <option value="">{labels.none}</option>
                {assistants.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            {noCrew && <p className="mt-1 text-xs text-warn">{labels.noCrewWarning}</p>}
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
