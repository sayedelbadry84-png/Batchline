"use client";

import { useRef, useState, useTransition } from "react";
import { enqueue } from "@/lib/offlineQueue";

type Status = "idle" | "saving" | "saved" | "error" | "queued" | "rejected";

// A typed { status } result, not Promise<void> (PL-R6-P2-02, sixth
// production-lifecycle review) — treating ANY resolved promise as
// success meant a rejected business outcome (a ticket that went
// COMPLETE/CANCELLED mid-edit, a stale component id, an out-of-range
// value) showed the same green checkmark as a real save. Only "OK"
// counts as saved now; every other status renders a distinct visible
// rejection and — critically — never updates lastSaved, so the field
// still looks unsaved (correctly) rather than quietly "succeeding".
type ActionResult = { status: string };

// A plain uncontrolled input, still fully wired for any surrounding
// <form>'s own submit (name + defaultValue), that also fires its own
// single-field save on blur — so a value is persisted the instant it's
// entered rather than only when the whole screen's form gets submitted.
//
// offlineQueueKind is opt-in, not automatic: only pass it for an action
// that's genuinely safe to replay blindly on reconnect (an idempotent
// field overwrite, like a scale reading) — see src/lib/offlineQueue.ts
// for why actions that create a row or transition state never queue.
export function AutoSaveField({
  action,
  hiddenFields,
  valueField,
  name,
  type = "number",
  step,
  defaultValue,
  placeholder,
  disabled,
  className,
  offlineQueueKind,
  rejectedLabel,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  hiddenFields: Record<string, string>;
  valueField: string;
  name: string;
  type?: string;
  step?: string;
  defaultValue?: string | number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  offlineQueueKind?: string;
  // A plain string, not a per-status function — the same Server→Client
  // serialization rule PL-R5-P1-02 already fixed elsewhere applies here
  // too. Shown as a title/tooltip on the rejection mark; a generic
  // message is enough since the specific reason is already logged
  // server-side and the value visibly never turned into a checkmark.
  rejectedLabel?: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [, startTransition] = useTransition();
  const lastSaved = useRef(defaultValue != null ? String(defaultValue) : "");

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.target.value;
    if (value === "" || value === lastSaved.current) return;

    const fields = { ...hiddenFields, [valueField]: value };

    if (offlineQueueKind && typeof navigator !== "undefined" && !navigator.onLine) {
      enqueue(offlineQueueKind, fields);
      lastSaved.current = value;
      setStatus("queued");
      return;
    }

    setStatus("saving");
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);

    startTransition(async () => {
      try {
        const result = await action(fd);
        if (result.status === "OK") {
          lastSaved.current = value;
          setStatus("saved");
          setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
        } else {
          // A genuine business rejection, not a network failure — never
          // queued (queuing would just retry the same rejection forever
          // once back online) and lastSaved stays exactly what it was,
          // so this field keeps looking unsaved.
          setStatus("rejected");
        }
      } catch {
        if (offlineQueueKind) {
          enqueue(offlineQueueKind, fields);
          lastSaved.current = value;
          setStatus("queued");
        } else {
          setStatus("error");
        }
      }
    });
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        name={name}
        type={type}
        step={step}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        onBlur={handleBlur}
        className={className}
      />
      <span className="w-3 shrink-0 font-mono text-xs">
        {status === "saving" && <span className="text-ink-faint">…</span>}
        {status === "saved" && <span className="text-good">✓</span>}
        {status === "error" && <span className="text-critical">!</span>}
        {status === "queued" && <span className="text-warn">⏳</span>}
        {status === "rejected" && (
          <span role="alert" className="text-critical" title={rejectedLabel}>
            ✕
          </span>
        )}
      </span>
    </span>
  );
}
