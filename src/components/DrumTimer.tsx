"use client";

import { useEffect, useState } from "react";

export function DrumTimer({ batchTimeIso, limitMinutes }: { batchTimeIso: string; limitMinutes: number }) {
  const [elapsedMin, setElapsedMin] = useState(() =>
    Math.floor((Date.now() - new Date(batchTimeIso).getTime()) / 60000),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setElapsedMin(Math.floor((Date.now() - new Date(batchTimeIso).getTime()) / 60000));
    }, 10_000);
    return () => clearInterval(id);
  }, [batchTimeIso]);

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
