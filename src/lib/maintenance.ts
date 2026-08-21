// Sixth AI/decision-layer feature this session: a simple preventive-
// maintenance flag for trucks and pumps, derived entirely from trip
// history the app already records — no new telemetry, no sensor feed.
// Same "prove it with what the app already tracks" approach as
// anomaly.ts, strength-prediction.ts, dispatch.ts, carbon.ts, and
// demand.ts.
export type MaintenanceInput = {
  id: string;
  lastMaintenanceAt: Date | null;
  tripBatchTimes: Date[];
};

export type MaintenanceResult = {
  id: string;
  tripsSinceLastMaintenance: number;
  dueForInspection: boolean;
};

export function flagMaintenanceDue(items: MaintenanceInput[], intervalTrips: number): MaintenanceResult[] {
  return items.map((item) => {
    const tripsSinceLastMaintenance = item.tripBatchTimes.filter(
      (batchTime) => item.lastMaintenanceAt == null || batchTime > item.lastMaintenanceAt,
    ).length;
    return {
      id: item.id,
      tripsSinceLastMaintenance,
      dueForInspection: tripsSinceLastMaintenance >= intervalTrips,
    };
  });
}
