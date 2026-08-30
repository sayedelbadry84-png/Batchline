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

// Derives an hourly rate from the same wageType/wageRate fields payroll
// itself pays from (see generatePayrollRun in employees/payroll/actions.ts,
// which turns a MONTHLY rate into a daily one via /30) — extended one step
// further into an hourly figure on a flat 8-hour-workday assumption, since
// there is no shift/overtime table anywhere in this schema to do better.
// An employee with no wage on file (wageType/wageRate unset) contributes 0
// rather than blocking the rest of the crew's cost from being computed.
const STANDARD_WORK_HOURS_PER_DAY = 8;

export function hourlyWageRate(employee: { wageType: string | null; wageRate: number | null }): number {
  if (!employee.wageType || !employee.wageRate) return 0;
  const dailyRate = employee.wageType === "MONTHLY" ? employee.wageRate / 30 : employee.wageRate;
  return dailyRate / STANDARD_WORK_HOURS_PER_DAY;
}

// Real labor cost from logged technician hours instead of a hand-typed
// guess at order-completion time — same role computeLaborCost's sibling,
// the parts.reduce(...) line already inline in completeMaintenanceOrder,
// plays for partsCost. A technician with no hoursWorked logged yet
// contributes 0, same as one with no wage on file.
export function computeLaborCost(technicians: { hoursWorked: number | null; employee: { wageType: string | null; wageRate: number | null } }[]): number {
  return technicians.reduce((sum, t) => sum + (t.hoursWorked ?? 0) * hourlyWageRate(t.employee), 0);
}
