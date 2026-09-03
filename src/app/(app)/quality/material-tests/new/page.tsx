import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createMaterialLabTest } from "../../actions";
import {
  MATERIAL_LAB_TEST_TYPES,
  MATERIAL_LAB_TEST_TYPE_KEYS,
  SIEVE_ANALYSIS_ROW_LABELS,
  SOUNDNESS_ROW_LABELS,
  type MaterialLabTestField,
  type MaterialLabTestType,
} from "@/lib/materialLabTests";

function FieldInput({ field, defaultOptionLabel }: { field: MaterialLabTestField; defaultOptionLabel?: string }) {
  if (field.type === "select") {
    return (
      <select name={field.key} required={field.required} className={`${ui.select} w-full`}>
        <option value="">{defaultOptionLabel ?? field.label}</option>
        {field.options?.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      name={field.key}
      type={field.type === "number" ? "number" : "text"}
      step={field.type === "number" ? "any" : undefined}
      required={field.required}
      className={`${ui.input} w-full`}
    />
  );
}

export default async function NewMaterialLabTestPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  await requirePageAccess("quality");
  const { type: typeRaw } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.quality;
  const d = m.materialTests;

  if (!typeRaw || !MATERIAL_LAB_TEST_TYPE_KEYS.includes(typeRaw as MaterialLabTestType)) notFound();
  const testType = typeRaw as MaterialLabTestType;
  const config = MATERIAL_LAB_TEST_TYPES[testType];

  const [suppliers, materialReceipts] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
    prisma.materialReceipt.findMany({
      orderBy: { receivedAt: "desc" },
      take: 100,
      include: { material: true, supplier: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/quality?tab=materialTests" className="text-sm text-accent-strong hover:underline">
          {d.backToList}
        </Link>
      </div>

      <header>
        <div className={ui.eyebrow}>{config.astmStandard}</div>
        <h1 className={ui.h1}>{d.types[testType]}</h1>
      </header>

      <form action={createMaterialLabTest} className={`${ui.card} flex flex-col gap-4`}>
        <input type="hidden" name="testType" value={testType} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={ui.label}>{d.f.materialDescription}</label>
            <input name="materialDescription" required className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.supplier}</label>
            <select name="supplierId" className={`${ui.select} w-full`}>
              <option value="">{dict.field.unassigned}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{d.f.source}</label>
            <input name="source" className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.labNumber}</label>
            <input name="labNumber" className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.materialReceipt}</label>
            <select name="materialReceiptId" className={`${ui.select} w-full`}>
              <option value="">{dict.field.unassigned}</option>
              {materialReceipts.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.receivedAt).toLocaleDateString()} — {r.material.name} — {r.supplier.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{d.f.reportDate}</label>
            <input name="reportDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className={`${ui.input} w-full`} />
          </div>
        </div>

        <h2 className="mt-2 font-display text-base font-semibold">{d.f.testDataTitle}</h2>
        <div className="grid grid-cols-2 gap-4">
          {config.fields.map((field) => (
            <div key={field.key}>
              <label className={ui.label}>{field.label}</label>
              <FieldInput field={field} />
            </div>
          ))}
        </div>

        {testType === "SIEVE_ANALYSIS" && (
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{d.f.sieveSize}</th>
                  <th className={ui.th}>{d.f.cumWeightRetained}</th>
                  <th className={ui.th}>{d.f.specLimit}</th>
                </tr>
              </thead>
              <tbody>
                {SIEVE_ANALYSIS_ROW_LABELS.map((label, i) => (
                  <tr key={label}>
                    <td className={`${ui.td} font-mono`}>{label}</td>
                    <td className={ui.td}>
                      <input name={`row_${i}_cumWeightRetainedG`} type="number" step="any" className={`${ui.input} w-32`} />
                    </td>
                    <td className={ui.td}>
                      <input name={`row_${i}_specLimit`} type="text" className={`${ui.input} w-28`} placeholder="90-100" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {testType === "SOUNDNESS_TEST" && (
          <>
            {(["AGGREGATE", "SAND"] as const).map((category) => (
              <div key={category}>
                <h3 className="mb-2 text-sm font-semibold">{d.f.soundnessCategory[category]}</h3>
                <div className="overflow-x-auto">
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th className={ui.th}>{d.f.sieveFraction}</th>
                        <th className={ui.th}>{d.f.pctRetained}</th>
                        <th className={ui.th}>{d.f.weightBefore}</th>
                        <th className={ui.th}>{d.f.weightAfter}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SOUNDNESS_ROW_LABELS[category].map((label, i) => (
                        <tr key={label}>
                          <td className={`${ui.td} font-mono`}>{label}</td>
                          <td className={ui.td}>
                            <input name={`row_${category}_${i}_pctRetained`} type="number" step="any" className={`${ui.input} w-24`} />
                          </td>
                          <td className={ui.td}>
                            <input name={`row_${category}_${i}_weightBeforeG`} type="number" step="any" className={`${ui.input} w-28`} />
                          </td>
                          <td className={ui.td}>
                            <input name={`row_${category}_${i}_weightAfterG`} type="number" step="any" className={`${ui.input} w-28`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}

        <h2 className="mt-2 font-display text-base font-semibold">{d.f.signOffTitle}</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={ui.label}>{d.f.sampledByName}</label>
            <input name="sampledByName" className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.sampledAt}</label>
            <input name="sampledAt" type="date" className={`${ui.input} w-full`} />
          </div>
          <div />
          <div>
            <label className={ui.label}>{d.f.testedByName}</label>
            <input name="testedByName" className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.testedAt}</label>
            <input name="testedAt" type="date" className={`${ui.input} w-full`} />
          </div>
          <div />
          <div>
            <label className={ui.label}>{d.f.checkedByName}</label>
            <input name="checkedByName" className={`${ui.input} w-full`} />
          </div>
          <div>
            <label className={ui.label}>{d.f.checkedAt}</label>
            <input name="checkedAt" type="date" className={`${ui.input} w-full`} />
          </div>
        </div>

        <div>
          <label className={ui.label}>{d.f.status}</label>
          <select name="status" defaultValue="PENDING" className={`${ui.select} w-48`}>
            <option value="PENDING">{d.status.PENDING}</option>
            <option value="PASSED">{d.status.PASSED}</option>
            <option value="FAILED">{d.status.FAILED}</option>
          </select>
        </div>

        <div>
          <label className={ui.label}>{d.f.remarks}</label>
          <textarea name="remarks" rows={2} className={`${ui.input} w-full`} />
        </div>

        <button type="submit" className={`${ui.button} mt-2 self-start`}>
          {d.save}
        </button>
      </form>
    </div>
  );
}
