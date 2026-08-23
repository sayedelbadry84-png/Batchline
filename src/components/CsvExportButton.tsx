"use client";

// A pre-built CSV string, handed off as a browser download — no route
// round-trip needed since the Server Component already has the same rows
// on screen. Same "operate on data the page already rendered" pattern as
// PrintButton/WhatsAppShareButton.
export function CsvExportButton({ label, filename, csv }: { label: string; filename: string; csv: string }) {
  function handleClick() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" onClick={handleClick} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
      {label}
    </button>
  );
}
