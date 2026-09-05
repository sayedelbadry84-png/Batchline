"use client";

import { useActionState, useMemo, useState } from "react";
import {
  saveReservationMixRevisionAction,
  cancelReservationMixRevisionAction,
} from "@/app/(app)/production/reservationMixActions";

export type MixOverrideRow = {
  materialId: string;
  materialName: string;
  materialType: string;
  designMassKgPerM3: number;
  dosageUnit: "KG" | "LITER";
  specificGravity: number | null;
  note: string | null;
};

export type AddableMaterial = { id: string; name: string; type: string; specificGravity: number | null };

export type ReservationMixEditorMessages = {
  scopedNotice: string;
  col: { material: string; type: string; original: string; modified: string; diff: string; total: string; note: string };
  addMaterialPlaceholder: string;
  addMaterialButton: string;
  removeButton: string;
  resetComponentButton: string;
  resetAllButton: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  saveButton: string;
  cancelButton: string;
  cancelRevisionButton: string;
  confirmSavePrompt: string;
  confirmCancelPrompt: string;
  waterCementWarning: string;
  // A plain string with a literal "{value}" placeholder, not a function —
  // this whole message bag crosses the Server → Client Component
  // boundary as a prop, and React's RSC serialization rejects function
  // values outright ("Functions cannot be passed directly to Client
  // Components"). The dictionary used to define this as a template
  // function; the page component was calling it correctly, but passing
  // the message object across the boundary at all meant even an unused
  // function elsewhere in that object throws.
  wcRatioNote: string;
  errorNotFound: string;
  errorInvalidState: string;
  errorNoComponents: string;
  errorDuplicateMaterial: string;
  errorInvalidQuantity: string;
  errorMaterialNotFound: string;
  errorInvalidReason: string;
  errorNoActiveRevision: string;
  unitKgShort: string;
  unitLiterShort: string;
};

function displayValue(row: { designMassKgPerM3: number; dosageUnit: "KG" | "LITER"; specificGravity: number | null }): number {
  return row.dosageUnit === "LITER" && row.specificGravity ? row.designMassKgPerM3 / row.specificGravity : row.designMassKgPerM3;
}

function saveErrorText(state: NonNullable<Awaited<ReturnType<typeof saveReservationMixRevisionAction>>>, m: ReservationMixEditorMessages): string | null {
  switch (state.status) {
    case "OK":
      return null;
    case "NOT_FOUND":
      return m.errorNotFound;
    case "INVALID_STATE":
      return m.errorInvalidState;
    case "NO_COMPONENTS":
      return m.errorNoComponents;
    case "DUPLICATE_MATERIAL":
      return m.errorDuplicateMaterial;
    case "INVALID_QUANTITY":
      return m.errorInvalidQuantity;
    case "MATERIAL_NOT_FOUND":
      return m.errorMaterialNotFound;
    case "INVALID_REASON":
      return m.errorInvalidReason;
  }
}

// The interactive editor for a reservation's copy-on-write mix revision.
// Everything here is client-side state until Save is pressed — nothing
// persists to localStorage, and nothing here bypasses the server-side
// validation in saveReservationMixRevision (this is UX only: the same
// checks run again, authoritatively, in the Server Action).
export function ReservationMixEditor({
  reservationId,
  volumeM3,
  originalComponents,
  initialComponents,
  hasActiveRevision,
  availableMaterials,
  materialTypeLabels,
  backHref,
  messages: m,
}: {
  reservationId: string;
  volumeM3: number;
  originalComponents: MixOverrideRow[];
  initialComponents: MixOverrideRow[];
  hasActiveRevision: boolean;
  availableMaterials: AddableMaterial[];
  materialTypeLabels: Record<string, string>;
  backHref: string;
  messages: ReservationMixEditorMessages;
}) {
  const [rows, setRows] = useState<MixOverrideRow[]>(initialComponents);
  const [reason, setReason] = useState("");
  const [addMaterialId, setAddMaterialId] = useState("");

  const [saveState, saveAction, savePending] = useActionState(saveReservationMixRevisionAction, null);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelReservationMixRevisionAction, null);

  const originalByMaterial = useMemo(() => new Map(originalComponents.map((c) => [c.materialId, c])), [originalComponents]);
  const rowMaterialIds = useMemo(() => new Set(rows.map((r) => r.materialId)), [rows]);
  const addableRemaining = availableMaterials.filter((mt) => !rowMaterialIds.has(mt.id));

  function updateQty(materialId: string, kgValue: number) {
    setRows((prev) => prev.map((r) => (r.materialId === materialId ? { ...r, designMassKgPerM3: kgValue } : r)));
  }
  function updateNote(materialId: string, note: string) {
    setRows((prev) => prev.map((r) => (r.materialId === materialId ? { ...r, note: note || null } : r)));
  }
  function removeRow(materialId: string) {
    setRows((prev) => prev.filter((r) => r.materialId !== materialId));
  }
  function resetRow(materialId: string) {
    const orig = originalByMaterial.get(materialId);
    if (!orig) return;
    setRows((prev) => prev.map((r) => (r.materialId === materialId ? { ...orig } : r)));
  }
  function resetAll() {
    setRows(originalComponents.map((c) => ({ ...c })));
  }
  function addMaterial() {
    const mat = availableMaterials.find((mt) => mt.id === addMaterialId);
    if (!mat) return;
    setRows((prev) => [
      ...prev,
      { materialId: mat.id, materialName: mat.name, materialType: mat.type, designMassKgPerM3: 0, dosageUnit: "KG", specificGravity: mat.specificGravity, note: null },
    ]);
    setAddMaterialId("");
  }

  // Client-side-only warning: no fixed engineering thresholds invented here
  // (per the ask), just a heads-up when water/cement/admixture quantities
  // moved from their original values, plus the resulting w/c ratio for the
  // operator to judge against their own standards.
  const sumByType = (list: MixOverrideRow[], type: string) => list.filter((r) => r.materialType === type).reduce((s, r) => s + r.designMassKgPerM3, 0);
  const waterNow = sumByType(rows, "WATER");
  const cementNow = sumByType(rows, "CEMENT");
  const waterOrig = sumByType(originalComponents, "WATER");
  const cementOrig = sumByType(originalComponents, "CEMENT");
  const admixtureChanged = rows.some((r) => r.materialType === "ADMIXTURE" && Math.abs(r.designMassKgPerM3 - (originalByMaterial.get(r.materialId)?.designMassKgPerM3 ?? 0)) > 1e-6);
  const showWcWarning = Math.abs(waterNow - waterOrig) > 1e-6 || Math.abs(cementNow - cementOrig) > 1e-6 || admixtureChanged;
  const wcRatio = cementNow > 0 ? waterNow / cementNow : null;

  const componentsJson = JSON.stringify(rows.map((r) => ({ materialId: r.materialId, designMassKgPerM3: r.designMassKgPerM3, note: r.note })));

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-strong">{m.scopedNotice}</p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.material}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.type}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.original}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.modified}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.diff}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.total}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase">{m.col.note}</th>
              <th className="border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const orig = originalByMaterial.get(r.materialId);
              const unit = r.dosageUnit === "LITER" && r.specificGravity ? m.unitLiterShort : m.unitKgShort;
              const modifiedDisplay = displayValue(r);
              const originalDisplay = orig ? displayValue(orig) : null;
              const diff = orig ? r.designMassKgPerM3 - orig.designMassKgPerM3 : r.designMassKgPerM3;
              const total = r.designMassKgPerM3 * volumeM3;
              return (
                <tr key={r.materialId}>
                  <td className="border-b border-border px-3 py-2.5">{r.materialName}</td>
                  <td className="border-b border-border px-3 py-2.5 text-xs text-ink-muted">{materialTypeLabels[r.materialType] ?? r.materialType}</td>
                  <td className="border-b border-border px-3 py-2.5 font-mono tabular text-xs text-ink-muted" dir="ltr">
                    {originalDisplay !== null ? `${originalDisplay.toFixed(2)} ${unit}` : "—"}
                  </td>
                  <td className="border-b border-border px-3 py-2.5">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      dir="ltr"
                      value={modifiedDisplay}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        const kg = r.dosageUnit === "LITER" && r.specificGravity ? v * r.specificGravity : v;
                        updateQty(r.materialId, kg);
                      }}
                      className="w-24 rounded-md border border-glass-border bg-surface px-2 py-1 font-mono text-xs outline-none focus:border-accent"
                    />{" "}
                    <span className="text-xs text-ink-muted">{unit}</span>
                  </td>
                  <td className={`border-b border-border px-3 py-2.5 font-mono tabular text-xs ${diff > 1e-6 ? "text-good" : diff < -1e-6 ? "text-critical" : "text-ink-muted"}`} dir="ltr">
                    {diff > 1e-6 ? "+" : ""}
                    {diff.toFixed(2)}
                  </td>
                  <td className="border-b border-border px-3 py-2.5 font-mono tabular text-xs" dir="ltr">{total.toFixed(1)} kg</td>
                  <td className="border-b border-border px-3 py-2.5">
                    <input
                      type="text"
                      value={r.note ?? ""}
                      onChange={(e) => updateNote(r.materialId, e.target.value)}
                      className="w-32 rounded-md border border-glass-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
                    />
                  </td>
                  <td className="border-b border-border px-3 py-2.5 whitespace-nowrap">
                    {orig && (
                      <button type="button" onClick={() => resetRow(r.materialId)} className="me-2 text-xs font-medium text-accent-strong hover:underline">
                        {m.resetComponentButton}
                      </button>
                    )}
                    <button type="button" onClick={() => removeRow(r.materialId)} className="text-xs font-medium text-critical hover:underline">
                      {m.removeButton}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={addMaterialId} onChange={(e) => setAddMaterialId(e.target.value)} className="rounded-md border border-glass-border bg-surface px-2 py-1.5 text-sm">
          <option value="">{m.addMaterialPlaceholder}</option>
          {addableRemaining.map((mt) => (
            <option key={mt.id} value={mt.id}>
              {mt.name} — {materialTypeLabels[mt.type] ?? mt.type}
            </option>
          ))}
        </select>
        <button type="button" onClick={addMaterial} disabled={!addMaterialId} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt disabled:opacity-50">
          {m.addMaterialButton}
        </button>
        <button type="button" onClick={resetAll} className="ms-auto text-sm font-medium text-accent-strong hover:underline">
          {m.resetAllButton}
        </button>
      </div>

      {showWcWarning && (
        <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
          {m.waterCementWarning}
          {wcRatio !== null && <span className="block font-mono tabular">{m.wcRatioNote.replace("{value}", wcRatio.toFixed(3))}</span>}
        </p>
      )}

      <form
        action={saveAction}
        onSubmit={(e) => {
          if (!confirm(m.confirmSavePrompt)) e.preventDefault();
        }}
        className="flex flex-col gap-2"
      >
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="componentsJson" value={componentsJson} />
        <label className="block text-xs font-medium text-ink-muted mb-1">{m.reasonLabel}</label>
        <textarea
          name="reason"
          required
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={m.reasonPlaceholder}
          className="w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={savePending}
            className="rounded-md bg-linear-to-br from-accent-strong to-accent px-4 py-2 text-sm font-medium text-[var(--on-accent)] shadow-[0_10px_20px_-10px_var(--accent-glow)] transition hover:-translate-y-0.5 disabled:opacity-50"
          >
            {m.saveButton}
          </button>
          <a href={backHref} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
            {m.cancelButton}
          </a>
        </div>
        {saveState && saveState.status !== "OK" && (
          <p role="alert" className="text-sm text-critical">
            {saveErrorText(saveState, m)}
          </p>
        )}
      </form>

      {hasActiveRevision && (
        <form
          action={cancelAction}
          onSubmit={(e) => {
            if (!confirm(m.confirmCancelPrompt)) e.preventDefault();
          }}
        >
          <input type="hidden" name="reservationId" value={reservationId} />
          <button type="submit" disabled={cancelPending} className="text-sm font-medium text-critical hover:underline">
            {m.cancelRevisionButton}
          </button>
          {cancelState && cancelState.status !== "OK" && (
            <p role="alert" className="text-sm text-critical">
              {cancelState.status === "NOT_FOUND" ? m.errorNotFound : m.errorNoActiveRevision}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
