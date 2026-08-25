"use client";

import { useMemo, useState } from "react";

// A type-to-filter picker over a plain options array, dropping a single
// hidden <input name> into whatever server-action form it's placed in —
// the rest of the form stays a plain uncontrolled server action, same
// pattern as RoleSelect/SitePlantSelect. No `required` on the hidden
// input: a required type="hidden" field can't receive focus, so Chrome
// silently blocks submission with no visible error — validation for this
// field is left to the server action instead, same as every other picker
// here already relies on its action's own guard clauses.
export function SearchableSelect({
  name,
  options,
  placeholder,
  defaultValue = "",
  defaultLabel = "",
  className,
}: {
  name: string;
  options: { value: string; label: string }[];
  placeholder: string;
  defaultValue?: string;
  defaultLabel?: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [query, setQuery] = useState(defaultLabel);
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!touched || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [touched, query, options]);

  return (
    <div className="relative">
      <input type="hidden" name={name} value={value} />
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setValue("");
          setTouched(true);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={className}
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          {filtered.length === 0 && <div className="px-3 py-2 text-xs text-ink-muted">—</div>}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setValue(o.value);
                setQuery(o.label);
                setTouched(false);
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-start text-sm hover:bg-surface-alt"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
