"use client";

import { useMemo, useState } from "react";
import { deriveAccentTheme, isValidHexColor } from "@/lib/accentColor";

// Lets a site set its own brand color, or clear back to the app's
// default amber — the value this submits under `name` is what
// Site.accentColor saves (see updateSite in (app)/plants/actions.ts,
// which validates and derives the rest of the accent family from it —
// see src/lib/accentColor.ts). The checkbox exists because an
// <input type="color"> can never itself represent "no color" — it always
// holds a valid hex — so "use the default" has to be tracked separately
// from whatever hex happens to be sitting in the picker.
export function AccentColorPicker({
  name,
  defaultValue,
  enableLabel,
  presets,
  previewLabel,
}: {
  name: string;
  defaultValue: string | null;
  enableLabel: string;
  presets: { label: string; value: string }[];
  previewLabel: string;
}) {
  const [enabled, setEnabled] = useState(Boolean(defaultValue));
  const [color, setColor] = useState(defaultValue ?? presets[0]?.value ?? "#2563eb");
  // Real derived tokens, not a guessed white-on-color preview — so what
  // the admin sees here (button fill + text color) is exactly what
  // globals.css's own button gradient will actually render, not an
  // approximation that could mislead them into a color that turns out
  // illegible.
  const derived = useMemo(() => (isValidHexColor(color) ? deriveAccentTheme(color) : null), [color]);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {enableLabel}
      </label>
      {!enabled && <input type="hidden" name={name} value="" />}
      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="color"
              name={name}
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <span className="font-mono text-xs text-ink-muted" dir="ltr">{color}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setColor(p.value)}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.value }} />
                {p.label}
              </button>
            ))}
          </div>
          {derived && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="w-fit rounded-md px-4 py-2 text-sm font-medium shadow-sm"
                style={{ background: `linear-gradient(to bottom right, ${derived.light.accentStrong}, ${derived.light.accent})`, color: derived.light.onAccent }}
              >
                {previewLabel}
              </button>
              <button
                type="button"
                className="w-fit rounded-md px-4 py-2 text-sm font-medium shadow-sm"
                style={{ background: `linear-gradient(to bottom right, ${derived.dark.accentStrong}, ${derived.dark.accent})`, color: derived.dark.onAccent }}
              >
                {previewLabel}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
