"use client";

import { useEffect } from "react";
import Link from "next/link";
import type { ReactNode } from "react";

// Visibility is driven by the URL (parent Server Component renders this
// only when its own ?new=1-style searchParam is set), not client state —
// same "no client-side router" convention the rest of the app already
// follows (see stock-ledger/reports' filter forms). This component is
// only the overlay chrome: backdrop, panel, title bar, and an Escape/×
// close that navigates back to closeHref.
export function Modal({ title, closeHref, children }: { title: string; closeHref: string; children: ReactNode }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") window.location.assign(closeHref);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeHref]);

  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 pt-10">
      <div className="w-full max-w-xl rounded-xl border border-border bg-surface p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <Link href={closeHref} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt" aria-label="Close">
            ✕
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}
