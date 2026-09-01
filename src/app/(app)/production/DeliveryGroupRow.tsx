"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";

// One reservation's row in the "all deliveries" table, collapsed to its
// summary by default — its own batch tickets (passed as `children`, each
// already a full <tr>) only render once this row is clicked. A reservation
// with many loads (a big pour split across dozens of trucks) used to push
// the whole table down a full screen of ticket rows; collapsed by default,
// the table reads as one row per reservation until you actually need the
// ticket-level detail.
export function DeliveryGroupRow({
  summaryCells,
  ticketCount,
  children,
}: {
  summaryCells: React.ReactNode;
  ticketCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="cursor-pointer bg-surface-alt hover:bg-surface" onClick={() => setOpen((o) => !o)}>
        <td className={ui.td}>
          <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-muted">
            <span aria-hidden>{open ? "▾" : "▸"}</span>
            {ticketCount}
          </span>
        </td>
        {summaryCells}
      </tr>
      {open && children}
    </>
  );
}
