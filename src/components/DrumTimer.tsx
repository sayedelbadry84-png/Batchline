"use client";

import { useEffect, useState } from "react";

function computeElapsedMin(batchTimeIso: string) {
  return Math.floor((Date.now() - new Date(batchTimeIso).getTime()) / 60000);
}

export function DrumTimer({ batchTimeIso, limitMinutes }: { batchTimeIso: string; limitMinutes: number }) {
  // Never compute Date.now() during render (including the useState
  // initializer) — the server and the client hydrate at different instants,
  // so any elapsed-time value computed there would mismatch and force a
  // full client re-render. Render a stable placeholder until the first
  // effect runs, then update on an interval from there.
  const [elapsedMin, setElapsedMin] = useState<number | null>(null);

  useEffect(() => {
    // The initial synchronous setState here is the deliberate hydration-safe
    // pattern for clock/timer values (React docs: synchronizing with an
    // external, time-based system) — the placeholder above is what SSR and
    // first client paint agree on; this is the one client-only update that
    // replaces it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElapsedMin(computeElapsedMin(batchTimeIso));
    const id = setInterval(() => setElapsedMin(computeElapsedMin(batchTimeIso)), 10_000);
    return () => clearInterval(id);
  }, [batchTimeIso]);

  if (elapsedMin === null) {
    return <span className="font-mono text-xs tabular text-ink-muted">— / {limitMinutes} min</span>;
  }

  const overLimit = elapsedMin > limitMinutes;
  const nearLimit = !overLimit && elapsedMin >= limitMinutes * 0.8;

  return (
    <span
      className={`font-mono text-xs tabular ${
        overLimit ? "font-semibold text-critical" : nearLimit ? "font-semibold text-warn" : "text-ink-muted"
      }`}
    >
      {elapsedMin} / {limitMinutes} min{overLimit ? " — over limit" : ""}
    </span>
  );
}
