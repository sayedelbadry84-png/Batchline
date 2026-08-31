// Shared AR/AP aging-bucket logic — used by Finance's own Aging tab
// (finance/page.tsx) and the Reports hub's AR Aging / AP Aging tabs
// (reportQueries.ts), so both read the same boundaries and the same bucket
// keys rather than two hand-maintained copies drifting apart.

export const AGING_BUCKETS = [
  { key: "current", max: 0 },
  { key: "d30", max: 30 },
  { key: "d60", max: 60 },
  { key: "d90", max: 90 },
  { key: "over90", max: Infinity },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

// Which bucket a balance falls into, by days past its own due date — not due
// yet (or due today) is "current"; everything else buckets by how many days
// overdue, same boundaries every AR/AP aging report in the industry uses
// (30/60/90).
export function agingBucket(dueDate: Date, now: Date): AgingBucketKey {
  const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d30";
  if (daysOverdue <= 60) return "d60";
  if (daysOverdue <= 90) return "d90";
  return "over90";
}
