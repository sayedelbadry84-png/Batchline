"use client";

import { useState } from "react";

// A button-group standing in for a single-select <select>, dropping one
// hidden <input name> into the surrounding server-action form. Optional
// onValueChange lets a parent client component (e.g. DeliveryPumpSection)
// react to the choice too, without this component needing to know why.
export function SegmentedControl({
  name,
  options,
  defaultValue = "",
  className,
  onValueChange,
}: {
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  className?: string;
  onValueChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <div className={`grid gap-2 ${className ?? ""}`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <input type="hidden" name={name} value={value} />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => {
            setValue(o.value);
            onValueChange?.(o.value);
          }}
          className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
            value === o.value
              ? "border-accent bg-accent-soft text-accent-strong"
              : "border-border bg-surface text-ink-muted hover:bg-surface-alt"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
