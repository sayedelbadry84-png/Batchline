import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createMixDesign } from "./actions";

const statusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  PENDING_APPROVAL: "bg-warn-soft text-warn",
  APPROVED: "bg-good-soft text-good",
  RETIRED: "bg-critical-soft text-critical",
};

export default async function MixDesignsPage() {
  await requirePageAccess("mix-designs");

  const mixes = await prisma.mixDesign.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { components: true } } },
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 01 — Mix Design</div>
        <h1 className={ui.h1}>Mix design library</h1>
        <p className={ui.intro}>
          Approved recipes — grade, exposure class, and per-m³ component
          targets. Open a mix to add components and see its computed yield
          factor.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Code</th>
                <th className={ui.th}>Grade</th>
                <th className={ui.th}>Slump</th>
                <th className={ui.th}>w/c</th>
                <th className={ui.th}>Components</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {mixes.map((m) => (
                <tr key={m.id}>
                  <td className={ui.td}>
                    <Link href={`/mix-designs/${m.id}`} className="font-medium text-accent-strong hover:underline">
                      {m.code}
                    </Link>
                  </td>
                  <td className={ui.td}>{m.grade}</td>
                  <td className={`${ui.td} font-mono tabular`}>{m.slumpTargetMm} mm</td>
                  <td className={`${ui.td} font-mono tabular`}>{m.wcRatio}</td>
                  <td className={`${ui.td} font-mono tabular`}>{m._count.components}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[m.status] ?? ""}`}>{m.status}</span>
                  </td>
                </tr>
              ))}
              {mixes.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={6}>
                    <span className="text-ink-muted">No mix designs yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createMixDesign} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New mix design</h2>
          <div>
            <label className={ui.label}>Code</label>
            <input name="code" required className={ui.input} placeholder="C30-20-S3" />
          </div>
          <div>
            <label className={ui.label}>Grade</label>
            <input name="grade" required className={ui.input} placeholder="C30/37" />
          </div>
          <div>
            <label className={ui.label}>Exposure class</label>
            <input name="exposureClass" className={ui.input} placeholder="XC2" />
          </div>
          <div>
            <label className={ui.label}>Slump target (mm)</label>
            <input name="slumpTargetMm" type="number" defaultValue={100} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>w/c ratio</label>
            <input name="wcRatio" type="number" step="0.01" defaultValue={0.5} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Yield target (m³)</label>
            <input name="yieldTargetM3" type="number" step="0.01" defaultValue={1} className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Create &amp; open
          </button>
        </form>
      </div>
    </div>
  );
}
