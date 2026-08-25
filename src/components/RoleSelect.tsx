"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";
import { OTHER_ROLE_SENTINEL } from "@/lib/employeeRole";

// The admin-tab role picker, plus an inline escape hatch: choosing "Other"
// reveals a text field for a brand-new job title instead of sending the
// operator away to a separate form first. Uncontrolled/defaultValue-based
// like every other plain field in these server-action forms — only
// whether the text field is shown is real client state.
export function RoleSelect({
  roleOptions,
  roleLabels,
  defaultValue,
  otherLabel,
  newRoleNamePlaceholder,
  className,
}: {
  roleOptions: string[];
  // A plain lookup map, not a function — Server Components can't pass
  // functions down to a Client Component like this one across the RSC
  // boundary, only serializable data.
  roleLabels: Record<string, string>;
  defaultValue?: string;
  otherLabel: string;
  newRoleNamePlaceholder: string;
  className?: string;
}) {
  const [isOther, setIsOther] = useState(false);
  const selectClass = className ?? ui.select;

  return (
    <>
      <select
        name={isOther ? undefined : "role"}
        defaultValue={defaultValue}
        onChange={(e) => setIsOther(e.target.value === OTHER_ROLE_SENTINEL)}
        required={!isOther}
        className={selectClass}
      >
        {roleOptions.map((r) => (
          <option key={r} value={r}>{roleLabels[r] ?? r}</option>
        ))}
        <option value={OTHER_ROLE_SENTINEL}>{otherLabel}</option>
      </select>
      {isOther && (
        <>
          <input type="hidden" name="role" value={OTHER_ROLE_SENTINEL} />
          <input name="newRoleName" placeholder={newRoleNamePlaceholder} required className={selectClass} />
        </>
      )}
    </>
  );
}
