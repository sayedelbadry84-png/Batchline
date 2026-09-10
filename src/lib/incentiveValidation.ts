export const INCENTIVE_ROLES = ["MIXER_DRIVER", "PUMP_OPERATOR", "PUMP_ASSISTANT", "BULKER_DRIVER", "WATER_TANKER_DRIVER"] as const;
export function assertIncentiveRole(role: string) {
  if (!(INCENTIVE_ROLES as readonly string[]).includes(role)) throw new Error("INVALID_INCENTIVE_ROLE");
}
export function nonNegativeNumber(data: FormData, field: string, fallback?: number): number {
  const raw = data.get(field);
  if (raw === null && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`INVALID_${field}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_${field}`);
  return value;
}
export function assertTripThresholds(free: number, tier2: number, tier3: number) {
  if (![free, tier2, tier3].every(Number.isSafeInteger) || free < 0 || free > tier2 || tier2 > tier3 || tier3 > 2147483647) throw new Error("INVALID_TRIP_THRESHOLDS");
}
export function assertReachRange(min: number, max: number | null) {
  if (max !== null && max <= min) throw new Error("INVALID_REACH_RANGE");
}
