"use client";

import { useRef, useState, useTransition } from "react";
import { enqueue } from "@/lib/offlineQueue";

type Status = "idle" | "saving" | "saved" | "error" | "queued";

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
}: {
  action: (formData: FormData) => Promise<void>;
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
        await action(fd);
        lastSaved.current = value;
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
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
      </span>
    </span>
  );
}
