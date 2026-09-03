import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { setMaterialLabTestStatus } from "../../actions";
import { MATERIAL_LAB_TEST_TYPES, type MaterialLabTestResults, type MaterialLabTestType } from "@/lib/materialLabTests";

const statusChip: Record<string, string> = {
  PENDING: "bg-surface-alt text-ink-muted",
  PASSED: "bg-good-soft text-good",
  FAILED: "bg-critical-soft text-critical",
};

function fmt(v: number | string | undefined): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

export default async function MaterialLabTestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("quality");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.quality;
  const d = m.materialTests;

  const test = await prisma.materialLabTest.findUnique({
    where: { id },
    include: { supplier: true, materialReceipt: { include: { material: true, supplier: true } }, createdBy: true },
  });
  if (!test) notFound();

  const testType = test.testType as MaterialLabTestType;
  const config = MATERIAL_LAB_TEST_TYPES[testType];
  const results = test.resultsJson as unknown as MaterialLabTestResults;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/quality?tab=materialTests" className="text-sm text-accent-strong hover:underline">
          {d.backToList}
        </Link>
      </div>

      <header className="flex items-start justify-between">
        <div>
          <div className={ui.eyebrow}>
            {test.testNumber} · {config.astmStandard}
          </div>
          <h1 className={ui.h1}>{d.types[testType]}</h1>
        </div>
        <span className={`${ui.chip} ${statusChip[test.status] ?? ""} text-sm`}>{d.status[test.status as keyof typeof d.status] ?? test.status}</span>
      </header>

      <div className={`${ui.card} grid grid-cols-3 gap-4`}>
        <div>
          <div className={ui.label}>{d.f.materialDescription}</div>
          <div className="font-medium">{test.materialDescription}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.supplier}</div>
          <div>{test.supplier?.name ?? "—"}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.source}</div>
          <div>{test.source ?? "—"}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.labNumber}</div>
          <div>{test.labNumber ?? "—"}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.reportDate}</div>
          <div className="font-mono tabular">{new Date(test.reportDate).toLocaleDateString()}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.materialReceipt}</div>
          <div>
            {test.materialReceipt
              ? `${new Date(test.materialReceipt.receivedAt).toLocaleDateString()} — ${test.materialReceipt.material.name} — ${test.materialReceipt.supplier.name}`
              : "—"}
          </div>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-base font-semibold">{d.f.testDataTitle}</h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          {config.fields.map((field) => (
            <div key={field.key} className="flex justify-between border-b border-border/50 py-1">
              <span className="text-ink-muted">{field.label}</span>
              <span className="font-mono tabular">{fmt(results?.inputs?.[field.key])}</span>
            </div>
          ))}
          {Object.entries(config.computedLabels).map(([key, label]) => (
            <div key={key} className="flex justify-between border-b border-border/50 py-1 font-medium">
              <span>{label}</span>
              <span className="font-mono tabular">{fmt(results?.computed?.[key])}</span>
            </div>
          ))}
        </div>
      </div>

      {testType === "SIEVE_ANALYSIS" && results?.rows && (
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.f.sieveSize}</th>
                <th className={ui.th}>{d.f.cumWeightRetained}</th>
                <th className={ui.th}>{d.f.retainedPct}</th>
                <th className={ui.th}>{d.f.passingPct}</th>
                <th className={ui.th}>{d.f.specLimit}</th>
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={row.label as string}>
                  <td className={`${ui.td} font-mono`}>{row.label}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.cumWeightRetainedG)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.retainedPct)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.passingPct)}</td>
                  <td className={ui.td}>{row.specLimit ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {testType === "SOUNDNESS_TEST" && results?.rows && (
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.f.sieveFraction}</th>
                <th className={ui.th}>{d.f.pctRetained}</th>
                <th className={ui.th}>{d.f.weightBefore}</th>
                <th className={ui.th}>{d.f.weightAfter}</th>
                <th className={ui.th}>{d.f.weightLoss}</th>
                <th className={ui.th}>{d.f.pctLoss}</th>
                <th className={ui.th}>{d.f.weightedPctLoss}</th>
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={row.label as string}>
                  <td className={`${ui.td} font-mono`}>{row.label}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.pctRetained)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.weightBeforeG)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.weightAfterG)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.weightLossG)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.pctLoss)}</td>
                  <td className={`${ui.td} font-mono tabular`}>{fmt(row.weightedPctLoss)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={`${ui.card} grid grid-cols-3 gap-4 text-sm`}>
        <div>
          <div className={ui.label}>{d.f.sampledByName}</div>
          <div>{test.sampledByName ?? "—"}</div>
          <div className="text-xs text-ink-muted">{test.sampledAt ? new Date(test.sampledAt).toLocaleDateString() : "—"}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.testedByName}</div>
          <div>{test.testedByName ?? "—"}</div>
          <div className="text-xs text-ink-muted">{test.testedAt ? new Date(test.testedAt).toLocaleDateString() : "—"}</div>
        </div>
        <div>
          <div className={ui.label}>{d.f.checkedByName}</div>
          <div>{test.checkedByName ?? "—"}</div>
          <div className="text-xs text-ink-muted">{test.checkedAt ? new Date(test.checkedAt).toLocaleDateString() : "—"}</div>
        </div>
      </div>

      {test.remarks && (
        <div className={ui.card}>
          <div className={ui.label}>{d.f.remarks}</div>
          <p className="text-sm">{test.remarks}</p>
        </div>
      )}

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-base font-semibold">{d.updateStatus}</h2>
        <form action={setMaterialLabTestStatus} className="flex items-end gap-2">
          <input type="hidden" name="id" value={test.id} />
          <div>
            <label className={ui.label}>{d.f.status}</label>
            <select name="status" defaultValue={test.status} className={`${ui.select} w-48`}>
              <option value="PENDING">{d.status.PENDING}</option>
              <option value="PASSED">{d.status.PASSED}</option>
              <option value="FAILED">{d.status.FAILED}</option>
            </select>
          </div>
          <button type="submit" className={ui.button}>
            {dict.field.save}
          </button>
        </form>
      </div>

      <div className="text-xs text-ink-faint">
        {d.createdBy(test.createdBy.name, new Date(test.createdAt).toLocaleDateString())}
      </div>
    </div>
  );
}
