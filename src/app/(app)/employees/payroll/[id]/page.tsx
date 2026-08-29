import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { PrintButton } from "@/components/PrintButton";
import { updatePayrollLine, approvePayrollRun, markPayrollRunPaid, cancelPayrollRun } from "../actions";

// Salary data — same ADMIN-only boundary as the payroll tab itself
// (employees/page.tsx) and every action in payroll/actions.ts.
export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("employees");
  if (user.role !== "ADMIN") redirect("/employees");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.employees;
  const p = m.payroll;

  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: { lines: { include: { employee: true }, orderBy: { id: "asc" } }, createdBy: true, approvedBy: true },
  });
  if (!run) notFound();

  const totalGross = run.lines.reduce((sum, l) => sum + l.grossPay, 0);
  const totalAdjustment = run.lines.reduce((sum, l) => sum + l.adjustment, 0);
  const totalNet = run.lines.reduce((sum, l) => sum + l.netPay, 0);
  const totalEmployeeGosi = run.lines.reduce((sum, l) => sum + l.employeeGosi, 0);
  const totalEmployerGosi = run.lines.reduce((sum, l) => sum + l.employerGosi, 0);
  const totalEmployerCost = totalNet + totalEmployeeGosi + totalEmployerGosi;
  const isDraft = run.status === "DRAFT";

  const statusChip: Record<string, string> = {
    DRAFT: "bg-surface-alt text-ink-muted",
    APPROVED: "bg-accent-soft text-accent-strong",
    PAID: "bg-good-soft text-good",
    CANCELLED: "bg-critical-soft text-critical",
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{p.eyebrow}</div>
          <h1 className={ui.h1}>{run.runNumber}</h1>
          <p className={ui.intro}>
            {new Date(run.periodStart).toLocaleDateString("en-GB")} — {new Date(run.periodEnd).toLocaleDateString("en-GB")}
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <span className={`${ui.chip} ${statusChip[run.status] ?? statusChip.DRAFT}`}>
            {p.statusLabel[run.status as keyof typeof p.statusLabel] ?? run.status}
          </span>
          <PrintButton label={p.print} />
        </div>
      </header>

      <div className="no-print flex flex-wrap gap-2">
        {isDraft && (
          <>
            <form action={approvePayrollRun}>
              <input type="hidden" name="id" value={run.id} />
              <button className={ui.button}>{p.approve}</button>
            </form>
            <form action={cancelPayrollRun}>
              <input type="hidden" name="id" value={run.id} />
              <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{p.cancel}</button>
            </form>
          </>
        )}
        {run.status === "APPROVED" && (
          <form action={markPayrollRunPaid}>
            <input type="hidden" name="id" value={run.id} />
            <button className={ui.button}>{p.markPaid}</button>
          </form>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.employeeCount}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{run.lines.length}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalGross}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{totalGross.toLocaleString()}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalAdjustment}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{totalAdjustment.toLocaleString()}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalNet}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-good" dir="ltr">{totalNet.toLocaleString()}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalEmployeeGosi}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{totalEmployeeGosi.toLocaleString()}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalEmployerGosi}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{totalEmployerGosi.toLocaleString()}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{p.totalEmployerCost}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-critical" dir="ltr">{totalEmployerCost.toLocaleString()}</div>
        </div>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{p.col.employee}</th>
              <th className={ui.th}>{p.col.wageType}</th>
              <th className={ui.th}>{p.col.wageRate}</th>
              <th className={ui.th}>{p.col.unpaidDays}</th>
              <th className={ui.th}>{p.col.grossPay}</th>
              <th className={ui.th}>{p.col.employeeGosi}</th>
              <th className={ui.th}>{p.col.employerGosi}</th>
              <th className={ui.th}>{p.col.adjustment}</th>
              <th className={ui.th}>{p.col.netPay}</th>
              {isDraft && <th className={ui.th}></th>}
            </tr>
          </thead>
          <tbody>
            {run.lines.map((l) => (
              <tr key={l.id}>
                <td className={`${ui.td} font-medium`}>{l.employee.name}</td>
                <td className={ui.td}>{p.wageTypeLabel[l.wageType as keyof typeof p.wageTypeLabel] ?? l.wageType}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.wageRate.toLocaleString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.unpaidDays}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.grossPay.toLocaleString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.employeeGosi.toLocaleString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.employerGosi.toLocaleString()}</td>
                <td className={ui.td}>
                  {isDraft ? (
                    <form action={updatePayrollLine} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={l.id} />
                      <input name="adjustment" type="number" step="0.01" defaultValue={l.adjustment} className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs" dir="ltr" />
                      <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{dict.field.save}</button>
                    </form>
                  ) : (
                    <span className="font-mono tabular" dir="ltr">{l.adjustment.toLocaleString()}</span>
                  )}
                </td>
                <td className={`${ui.td} font-mono tabular font-semibold`} dir="ltr">{l.netPay.toLocaleString()}</td>
              </tr>
            ))}
            {run.lines.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={isDraft ? 10 : 9}>
                  <span className="text-ink-muted">{p.emptyLines}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Link href="/employees?tab=payroll" className="no-print text-sm font-medium text-accent-strong hover:underline">
        {p.back}
      </Link>
    </div>
  );
}
