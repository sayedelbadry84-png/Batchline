// Shared Tailwind class strings so every module page renders with the same
// table/card/input treatment instead of re-deriving spacing per screen.
export const ui = {
  eyebrow:
    "mb-1 flex items-center gap-2 font-mono text-xs tracking-widest text-accent-strong uppercase before:block before:h-[2px] before:w-5 before:bg-accent",
  h1: "font-display text-3xl font-semibold text-ink",
  intro: "mt-1 max-w-2xl text-sm text-ink-muted",
  // .glass-surface (globals.css) carries the blur/gradient/shadow combo
  // Tailwind utilities can't express directly — reserved for panel-level
  // containers like this one. Tables, inputs, and the sidebar stay
  // opaque/flat on purpose: legibility for dense data, and stacking many
  // blurred layers is genuinely slow.
  card: "glass-surface rounded-xl border border-glass-border p-6",
  table: "w-full border-collapse text-sm",
  th: "border-b border-border bg-surface-alt px-3 py-2 text-start font-mono text-[0.68rem] tracking-wide text-ink-muted uppercase",
  td: "border-b border-border px-3 py-2.5",
  input:
    "w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent",
  label: "block text-xs font-medium text-ink-muted mb-1",
  select:
    "w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent",
  button:
    "rounded-md bg-linear-to-br from-accent-strong to-accent px-4 py-2 text-sm font-medium text-[var(--on-accent)] shadow-[0_10px_20px_-10px_var(--accent-glow)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_26px_-10px_var(--accent-glow)]",
  chip: "inline-block rounded-full px-2.5 py-0.5 font-mono text-[0.7rem]",
};
