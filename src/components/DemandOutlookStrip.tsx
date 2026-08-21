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
}: {
  title: string;
  intro: string;
  buckets: DayBucket[];
  countLabel: (n: number) => string;
}) {
  return (
    <div>
      <h2 className="mb-1 font-display text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-ink-muted">{intro}</p>
      <div className="grid grid-cols-7 gap-2">
        {buckets.map((day) => (
          <div key={day.dateKey} className={`${ui.card} py-3 text-center`}>
            <div className="font-mono text-[0.65rem] tracking-wide text-ink-faint uppercase">
              {day.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
            </div>
            <div className="mt-1 font-mono text-lg tabular">{day.volumeM3 > 0 ? day.volumeM3.toFixed(1) : "—"}</div>
            {day.count > 0 && <div className="text-xs text-ink-muted">{countLabel(day.count)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
