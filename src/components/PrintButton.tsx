"use client";

// "Export PDF" without a server-side PDF library or new dependency — the
// browser's own print pipeline (File > Save as PDF in the print dialog)
// against report pages that already render as clean HTML tables. Sidebar
// and buttons opt out via the .no-print rule in globals.css.
export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
    >
      {label}
    </button>
  );
}
