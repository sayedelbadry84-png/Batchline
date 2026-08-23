import { ui } from "@/lib/ui";
import type { DayBucket } from "@/lib/demand";

// Plain server-renderable component (no "use client") — shared between
// Reports and the dashboard so the two don't drift into two slightly
// different renderings of the same 7-day reservation pipeline.
export function DemandOutlookStrip({
  title,
  intro,
  buckets,
  countLabel,
  typicalLabel,
}: {
  title: string;
  intro: string;
  buckets: DayBucket[];
  countLabel: (n: number) => string;
  typicalLabel?: (v: string) => string;
}) {
  return (
    <div>
      <h2 className="mb-1 font-display text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-ink-muted">{intro}</p>
      <div className="grid grid-cols-7 gap-2">
        {buckets.map((day) => {
          // A booked day well below its own weekday's usual volume is
          // worth a glance even though nothing here is actually wrong —
          // purely a visual nudge, never an alert.
          const light = day.typicalVolumeM3 != null && day.typicalVolumeM3 > 0.5 && day.volumeM3 < day.typicalVolumeM3 * 0.5;
          return (
            <div key={day.dateKey} className={`${ui.card} py-3 text-center`}>
              <div className="font-mono text-[0.65rem] tracking-wide text-ink-faint uppercase">
                {day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </div>
              <div className={`mt-1 font-mono text-lg tabular ${light ? "text-warn" : ""}`}>{day.volumeM3 > 0 ? day.volumeM3.toFixed(1) : "—"}</div>
              {day.count > 0 && <div className="text-xs text-ink-muted">{countLabel(day.count)}</div>}
              {typicalLabel && day.typicalVolumeM3 != null && day.typicalVolumeM3 > 0.5 && (
                <div className="mt-0.5 text-xs text-ink-faint">{typicalLabel(day.typicalVolumeM3.toFixed(1))}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
