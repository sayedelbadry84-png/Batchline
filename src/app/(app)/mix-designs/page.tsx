import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createMixDesign } from "./actions";

const statusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  PENDING_APPROVAL: "bg-warn-soft text-warn",
  APPROVED: "bg-good-soft text-good",
  RETIRED: "bg-critical-soft text-critical",
};

export default async function MixDesignsPage() {
  await requirePageAccess("mix-designs");
  const { dict } = await getDictionary();
  const m = dict.modules.mixDesigns;

  const mixes = await prisma.mixDesign.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { components: true } } },
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.listTitle}</h1>
        <p className={ui.intro}>{m.listIntro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.code}</th>
                <th className={ui.th}>{m.col.grade}</th>
                <th className={ui.th}>{m.col.slump}</th>
                <th className={ui.th}>{m.col.wc}</th>
                <th className={ui.th}>{m.col.components}</th>
                <th className={ui.th}>{m.col.status}</th>
              </tr>
            </thead>
            <tbody>
              {mixes.map((mx) => (
                <tr key={mx.id}>
                  <td className={ui.td}>
                    <Link href={`/mix-designs/${mx.id}`} className="font-medium text-accent-strong hover:underline" dir="ltr">
                      {mx.code}
                    </Link>
                  </td>
                  <td className={ui.td} dir="ltr">{mx.grade}</td>
                  <td className={`${ui.td} font-mono tabular`}>{mx.slumpTargetMm} mm</td>
                  <td className={`${ui.td} font-mono tabular`}>{mx.wcRatio}</td>
                  <td className={`${ui.td} font-mono tabular`}>{mx._count.components}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[mx.status] ?? ""}`}>{dict.status[mx.status as keyof typeof dict.status] ?? mx.status}</span>
                  </td>
                </tr>
              ))}
              {mixes.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createMixDesign} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.code}</label>
            <input name="code" required className={ui.input} placeholder="C30-20-S3" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.grade}</label>
            <input name="grade" required className={ui.input} placeholder="C30/37" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.exposureClass}</label>
            <input name="exposureClass" className={ui.input} placeholder="XC2" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.slumpTarget}</label>
            <input name="slumpTargetMm" type="number" defaultValue={100} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.wcRatio}</label>
            <input name="wcRatio" type="number" step="0.01" defaultValue={0.5} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.yieldTarget}</label>
            <input name="yieldTargetM3" type="number" step="0.01" defaultValue={1} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.createAndOpen}
          </button>
        </form>
      </div>
    </div>
  );
}
