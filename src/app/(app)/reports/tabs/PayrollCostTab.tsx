// Extracted from reports/page.tsx on 2026-09-12, which had grown to one
// 2,600-line function holding twenty-five tabs' worth of markup. The JSX
// below is byte-identical to what lived there; only its surroundings are
// new. Props are named after the variables the block already closed over,
// so the markup needed no edits at all — the safest way to split a file
// that big, since any change inside it would have been invisible against
// the noise of the move.
import { ExportBar, type ReportTabContext } from "../reportUi";
import { getPayrollCostReport } from "@/lib/reportQueries";
import { ui } from "@/lib/ui";
import { formatByCurrency } from "@/lib/currencyTotals";

export function PayrollCostTab({ payrollCostData, ctx }: {
  payrollCostData: NonNullable<Awaited<ReturnType<typeof getPayrollCostReport>>>;
  ctx: ReportTabContext;
}) {
  const { dict, rangeFrom, rangeTo } = ctx;
  const m = dict.modules.reports;
  return (
      <div className="flex flex-col gap-4">
        <ExportBar
          m={m}
          tab="payrollCost"
          from={rangeFrom}
          to={rangeTo}
          message={`${m.tabs.payrollCost} ${rangeFrom} → ${rangeTo}\n${m.payrollCostReport.lineCount(payrollCostData.lineCount)}\n${m.payrollCostReport.totalCost(formatByCurrency(payrollCostData.totalCost))}`}
          filenameBase={`payroll-cost-${rangeFrom}-${rangeTo}`}
          headers={["Run", "Employee", "Role", "Wage type", "Wage rate", "Unpaid days", "Gross pay", "Incentive", "Employer GOSI", "Net pay", "Currency"]}
          rows={payrollCostData.rows.map((l) => [
            l.runNumber,
            l.employee.name,
            l.employee.role,
            l.wageType,
            l.wageRate,
            l.unpaidDays,
            l.grossPay,
            l.incentiveAmount,
            l.employerGosi,
            l.netPay,
            l.currency,
          ])}
        />
        <p className="text-sm text-ink-muted">{m.payrollCostReport.intro}</p>
        <p className="text-xs text-ink-muted">{m.payrollCostReport.currencyNote}</p>
        <div className="flex flex-wrap gap-4">
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{payrollCostData.lineCount}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.payrollCostReport.lineCount(payrollCostData.lineCount)}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{formatByCurrency(payrollCostData.totalGross)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.payrollCostReport.totalGross}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{formatByCurrency(payrollCostData.totalIncentives)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.payrollCostReport.totalIncentives}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular">{formatByCurrency(payrollCostData.totalEmployerGosi)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.payrollCostReport.totalEmployerGosi}</div>
          </div>
          <div className={ui.card}>
            <div className="font-mono text-2xl tabular font-semibold">{formatByCurrency(payrollCostData.totalCost)}</div>
            <div className="mt-1 text-sm text-ink-muted">{m.payrollCostReport.totalCost(formatByCurrency(payrollCostData.totalCost))}</div>
          </div>
        </div>
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.payrollCostReport.col.run}</th>
                <th className={ui.th}>{m.payrollCostReport.col.employee}</th>
                <th className={ui.th}>{m.payrollCostReport.col.role}</th>
                <th className={ui.th}>{m.payrollCostReport.col.grossPay}</th>
                <th className={ui.th}>{m.payrollCostReport.col.incentive}</th>
                <th className={ui.th}>{m.payrollCostReport.col.employerGosi}</th>
                <th className={ui.th}>{m.payrollCostReport.col.netPay}</th>
              </tr>
            </thead>
            <tbody>
              {payrollCostData.rows.map((l) => (
                <tr key={l.id}>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{l.runNumber}</td>
                  <td className={ui.td}>{l.employee.name}</td>
                  <td className={ui.td}>{l.employee.role}</td>
                  <td className={`${ui.td} font-mono tabular`}>{l.grossPay.toFixed(2)} {l.currency}</td>
                  <td className={`${ui.td} font-mono tabular`}>{l.incentiveAmount.toFixed(2)} {l.currency}</td>
                  <td className={`${ui.td} font-mono tabular`}>{l.employerGosi.toFixed(2)} {l.currency}</td>
                  <td className={`${ui.td} font-mono tabular font-semibold`}>{l.netPay.toFixed(2)} {l.currency}</td>
                </tr>
              ))}
              {payrollCostData.rows.length === 0 && (
                <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.noRows}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
