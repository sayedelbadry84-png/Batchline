// Saudi end-of-service gratuity (مكافأة نهاية الخدمة) — Labor Law Articles
// 84-85. Illustrative, same posture as GOSI_DEFAULTS in
// employees/payroll/actions.ts: verify against the current official rules
// (and any employment-contract terms that exceed the statutory minimum)
// before relying on this for a real settlement — this computes the
// statutory floor, not necessarily what a specific contract promises.

export const TERMINATION_TYPES = ["RESIGNATION", "TERMINATED_BY_EMPLOYER", "END_OF_CONTRACT", "SPECIAL_CASE"] as const;
export type TerminationType = (typeof TERMINATION_TYPES)[number];

export type EndOfServiceCalcInput = {
  hireDate: Date;
  terminationDate: Date;
  terminationType: TerminationType;
  // The employee's basic MONTHLY wage — Article 85 excludes housing/
  // transport allowances, so this should be the base figure alone. A
  // DAILY-wage employee has no single "monthly" number on file; the
  // caller is responsible for converting (see wageRate handling in
  // calculateEndOfServiceSettlement, employees/actions.ts) and should
  // treat that conversion as an estimate, not a payroll-verified figure.
  basicMonthlySalary: number;
};

export type EndOfServiceCalcResult = {
  yearsOfService: number;
  // Article 84's own formula result: half a month per year for the first
  // 5 years, a full month per year beyond that — before any resignation
  // reduction is applied.
  grossEntitlement: number;
  // The tier multiplier Article 85 applies when the employee is the one
  // resigning (1 for every other termination type).
  resignationMultiplier: number;
  payableAmount: number;
};

function yearsBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

// Article 85: an employee who resigns keeps none of the gratuity under 2
// years of service, a third of it from 2 up to 5 years, two-thirds from 5
// up to 10, and the full amount at 10 years or more. Every other
// termination type (employer-initiated, contract end, or one of the law's
// own full-award exceptions — force majeure, a woman resigning within 6
// months of marriage or 3 months of childbirth, etc.) keeps the full
// amount regardless of tenure.
function resignationMultiplier(years: number, type: TerminationType): number {
  if (type !== "RESIGNATION") return 1;
  if (years < 2) return 0;
  if (years < 5) return 1 / 3;
  if (years < 10) return 2 / 3;
  return 1;
}

export function calculateEndOfServiceEntitlement({ hireDate, terminationDate, terminationType, basicMonthlySalary }: EndOfServiceCalcInput): EndOfServiceCalcResult {
  const yearsOfService = yearsBetween(hireDate, terminationDate);
  const firstFiveYears = Math.min(yearsOfService, 5);
  const yearsBeyondFive = Math.max(yearsOfService - 5, 0);
  const grossEntitlement = firstFiveYears * 0.5 * basicMonthlySalary + yearsBeyondFive * 1 * basicMonthlySalary;
  const multiplier = resignationMultiplier(yearsOfService, terminationType);
  return {
    yearsOfService,
    grossEntitlement,
    resignationMultiplier: multiplier,
    payableAmount: grossEntitlement * multiplier,
  };
}
