"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";

type ProjectOption = { id: string; label: string; customerId: string };
type MixOption = { id: string; label: string };
type PricedPair = { customerId: string; mixId: string };

// Project and mix have to be picked together here — the mix list narrows
// to only mixes with a price on file for whichever customer the selected
// project belongs to, since createReservation/updateReservation now
// refuse to open a reservation for a customer+mix pair with none (see the
// hasPriceOnFile gate in the Reservations actions). Same
// "remount to refresh options" trick QuoteLineRows already uses for its
// customer-driven mix suggestions.
export function ReservationMixSelect({
  projects,
  mixes,
  pricedPairs,
  defaultProjectId,
  defaultMixId,
  labels,
}: {
  projects: ProjectOption[];
  mixes: MixOption[];
  pricedPairs: PricedPair[];
  defaultProjectId?: string;
  defaultMixId?: string;
  labels: {
    project: string;
    projectPlaceholder: string;
    mix: string;
    mixPlaceholder: string;
    noPricedMix: string;
  };
}) {
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const customerId = projects.find((p) => p.id === projectId)?.customerId ?? "";
  const pricedMixIds = new Set(pricedPairs.filter((pp) => pp.customerId === customerId).map((pp) => pp.mixId));
  const priced = customerId ? mixes.filter((mx) => pricedMixIds.has(mx.id)) : mixes;
  // A reservation being edited keeps its own already-assigned mix
  // selectable even when it has no price on file (predates the rule, or
  // its price was since removed) — only switching to a *different*
  // unpriced mix is refused, never silently hiding what's already there.
  // But that grandfathering only holds while the project (and therefore
  // customer) is still the one the reservation already had — the moment
  // the project is changed to something else, the old mix is just as
  // unpriced-for-this-new-customer as any other, so it must not linger
  // as a pre-selected option.
  const stillOnOriginalProject = projectId === (defaultProjectId ?? "");
  const grandfathered = stillOnOriginalProject && defaultMixId && !priced.some((mx) => mx.id === defaultMixId) ? mixes.find((mx) => mx.id === defaultMixId) : undefined;
  const availableMixes = grandfathered ? [...priced, grandfathered] : priced;

  return (
    <>
      <div>
        <label className={ui.label}>{labels.project}</label>
        <select
          name="projectId"
          required
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={`${ui.select} w-44`}
        >
          <option value="" disabled>{labels.projectPlaceholder}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={ui.label}>{labels.mix}</label>
        <select
          key={customerId}
          name="mixId"
          required
          defaultValue={stillOnOriginalProject ? (defaultMixId ?? "") : ""}
          className={`${ui.select} w-36`}
        >
          <option value="" disabled>{labels.mixPlaceholder}</option>
          {availableMixes.map((mx) => (
            <option key={mx.id} value={mx.id}>{mx.label}</option>
          ))}
        </select>
        {customerId && availableMixes.length === 0 && <p className="mt-1 text-xs text-warn">{labels.noPricedMix}</p>}
      </div>
    </>
  );
}
