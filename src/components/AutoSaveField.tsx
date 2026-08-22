"use client";

import { useRef, useState, useTransition } from "react";

type Status = "idle" | "saving" | "saved" | "error";

// A plain uncontrolled input, still fully wired for any surrounding
// <form>'s own submit (name + defaultValue), that also fires its own
// single-field save on blur — so a value is persisted the instant it's
// entered rather than only when the whole screen's form gets submitted.
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
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [, startTransition] = useTransition();
  const lastSaved = useRef(defaultValue != null ? String(defaultValue) : "");

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.target.value;
    if (value === "" || value === lastSaved.current) return;

    setStatus("saving");
    const fd = new FormData();
    for (const [k, v] of Object.entries(hiddenFields)) fd.set(k, v);
    fd.set(valueField, value);

    startTransition(async () => {
      try {
        await action(fd);
        lastSaved.current = value;
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
      } catch {
        setStatus("error");
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
      </span>
    </span>
  );
}
