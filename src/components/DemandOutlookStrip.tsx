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
  const maxVolume = Math.max(...buckets.map((day) => day.volumeM3), 1);

  return (
    <div className={ui.card}>
      <h2 className="mb-1 font-display text-lg font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-ink-muted">{intro}</p>
      <div className="flex items-end gap-2" style={{ height: "9.5rem" }}>
        {buckets.map((day) => {
          // A booked day well below its own weekday's usual volume is
          // worth a glance even though nothing here is actually wrong —
          // purely a visual nudge, never an alert.
          const light = day.typicalVolumeM3 != null && day.typicalVolumeM3 > 0.5 && day.volumeM3 < day.typicalVolumeM3 * 0.5;
          const heightPct = day.volumeM3 > 0 ? Math.max(8, (day.volumeM3 / maxVolume) * 100) : 0;
          return (
            <div key={day.dateKey} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5 text-center">
              <div className="flex h-16 w-full items-end justify-center">
                {heightPct > 0 && (
                  <div
                    className={`w-2/3 rounded-t-md ${light ? "bg-warn" : "bg-linear-to-b from-accent-strong to-accent"}`}
                    style={{ height: `${heightPct}%` }}
                  />
                )}
              </div>
              <div className="font-mono text-[0.65rem] tracking-wide text-ink-faint uppercase">
                {day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </div>
              <div className={`font-mono text-sm tabular ${light ? "text-warn" : ""}`}>{day.volumeM3 > 0 ? day.volumeM3.toFixed(1) : "—"}</div>
              {day.count > 0 && <div className="text-[0.65rem] text-ink-muted">{countLabel(day.count)}</div>}
              {typicalLabel && day.typicalVolumeM3 != null && day.typicalVolumeM3 > 0.5 && (
                <div className="text-[0.65rem] text-ink-faint">{typicalLabel(day.typicalVolumeM3.toFixed(1))}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
