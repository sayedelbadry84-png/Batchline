"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";

type SiteWithPlants = { id: string; code: string; name: string; plants: { id: string; name: string }[] };

// Two dependent <select>s standing in for a single "which plant" field —
// pick the Site by its code first, then the line select below it narrows
// to just that site's own lines. Only the line select actually posts
// (name={name}, default "plantId"); the site select is pure client-side
// state used to filter the second list. Uncontrolled by design (default-
// value based) so it works the same as every other field in these plain
// server-action forms — remounting the line select on site change (via
// `key={siteId}`) is what clears a stale selection from a different site.
export function SitePlantSelect({
  sites,
  name = "plantId",
  siteFieldName,
  defaultPlantId,
  required,
  className,
  siteLabel,
  plantLabel,
  sitePlaceholder,
  plantPlaceholder,
}: {
  sites: SiteWithPlants[];
  name?: string;
  // When set, the site-level pick is also posted as its own named field
  // (needed anywhere a form wants both the Plant and the Station, e.g.
  // Production's manual booking, which creates a Reservation.siteId and
  // immediately releases a BatchTicket.plantId in one submit).
  siteFieldName?: string;
  defaultPlantId?: string;
  required?: boolean;
  className?: string;
  siteLabel: string;
  plantLabel: string;
  sitePlaceholder: string;
  plantPlaceholder: string;
}) {
  const initialSiteId = defaultPlantId
    ? sites.find((s) => s.plants.some((p) => p.id === defaultPlantId))?.id
    : undefined;
  const [siteId, setSiteId] = useState(initialSiteId ?? "");
  const site = sites.find((s) => s.id === siteId);
  const selectClass = className ?? ui.select;

  return (
    <>
      <div>
        <label className={ui.label}>{siteLabel}</label>
        <select
          name={siteFieldName}
          defaultValue={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          required={siteFieldName ? required : undefined}
          className={selectClass}
        >
          <option value="">{sitePlaceholder}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={ui.label}>{plantLabel}</label>
        <select
          key={siteId}
          name={name}
          defaultValue={defaultPlantId}
          required={required}
          disabled={!site}
          className={selectClass}
        >
          <option value="">{plantPlaceholder}</option>
          {(site?.plants ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
