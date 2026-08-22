"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";

// Renders as siblings inside the parent's <tr> — the checkboxes and the
// Save button below live in their own <td>s but aren't DOM descendants of
// the <form> (that form sits in the last cell); the HTML `form` attribute
// on each control is what still submits them together, without needing a
// <form> to wrap the whole row.
export function PermissionRow({
  formId,
  roles,
  roleLabels,
  initialChecked,
  saveLabel,
  warningLabel,
}: {
  formId: string;
  roles: readonly string[];
  roleLabels: Record<string, string>;
  initialChecked: string[];
  saveLabel: string;
  warningLabel: string;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(initialChecked));

  function toggle(role: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  const empty = checked.size === 0;

  return (
    <>
      {roles.map((r) => (
        <td key={r} className={`${ui.td} text-center`}>
          <input
            form={formId}
            type="checkbox"
            name="roles"
            value={r}
            checked={checked.has(r)}
            onChange={() => toggle(r)}
            aria-label={roleLabels[r]}
            className="h-4 w-4 accent-accent"
          />
        </td>
      ))}
      <td className={ui.td}>
        <button
          form={formId}
          type="submit"
          disabled={empty}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saveLabel}
        </button>
        {empty && <div className="mt-1 text-xs text-critical">{warningLabel}</div>}
      </td>
    </>
  );
}
