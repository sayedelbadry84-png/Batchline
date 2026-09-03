import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  startInternalAudit,
  completeInternalAudit,
  addAuditFinding,
  saveAuditFinding,
  closeAuditFinding,
} from "../../actions";

const statusChip: Record<string, string> = {
  SCHEDULED: "bg-surface-alt text-ink-muted",
  IN_PROGRESS: "bg-warn-soft text-warn",
  COMPLETED: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

const findingStatusChip: Record<string, string> = {
  OPEN: "bg-critical-soft text-critical",
  IN_PROGRESS: "bg-warn-soft text-warn",
  CLOSED: "bg-good-soft text-good",
};

export default async function InternalAuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("quality");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.quality;
  const d = m.audits;

  const audit = await prisma.internalAudit.findUnique({
    where: { id },
    include: {
      auditor: true,
      createdBy: true,
      findings: { orderBy: { createdAt: "asc" }, include: { responsible: true } },
    },
  });
  if (!audit) notFound();

  const qualityUsers = await prisma.user.findMany({ where: { role: { in: ["QUALITY_SUPERVISOR", "ADMIN"] } }, orderBy: { name: "asc" } });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{d.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">{audit.auditNumber}</h1>
          <p className={ui.intro}>{audit.department}{audit.processAudited ? ` — ${audit.processAudited}` : ""}</p>
        </div>
        <span className={`${ui.chip} ${statusChip[audit.status] ?? ""}`}>
          {d.statusLabel[audit.status as keyof typeof d.statusLabel] ?? audit.status}
        </span>
      </header>

      <div className={ui.card}>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-ink-muted">{d.col.auditor}</div>
            <div>{audit.auditor.name}</div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">{d.col.scheduledDate}</div>
            <div className="font-mono tabular">{new Date(audit.scheduledDate).toLocaleDateString()}</div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">{d.isoClauseScope}</div>
            <div dir="ltr">{audit.isoClauseScope ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-ink-muted">{d.startedAt}</div>
            <div className="font-mono tabular">{audit.startedAt ? new Date(audit.startedAt).toLocaleDateString() : "—"}</div>
          </div>
        </div>

        {audit.status === "SCHEDULED" && (
          <form action={startInternalAudit} className="mt-4">
            <input type="hidden" name="id" value={audit.id} />
            <button type="submit" className={ui.button}>{d.start}</button>
          </form>
        )}

        {(audit.status === "SCHEDULED" || audit.status === "IN_PROGRESS") && (
          <form action={completeInternalAudit} className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
            <h2 className="font-display text-base font-semibold">{d.completeTitle}</h2>
            <input type="hidden" name="id" value={audit.id} />
            <div>
              <label className={ui.label}>{d.f.areasFoundGood}</label>
              <textarea name="areasFoundGood" rows={2} className="w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
            </div>
            <div>
              <label className={ui.label}>{d.f.observations}</label>
              <textarea name="observations" required rows={3} placeholder={d.f.observationsPlaceholder} className="w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
            </div>
            <button type="submit" className={`${ui.button} w-fit`}>{d.complete}</button>
          </form>
        )}

        {audit.status === "COMPLETED" && (
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4 text-sm">
            {audit.areasFoundGood && (
              <div><span className="text-ink-muted">{d.f.areasFoundGood}: </span>{audit.areasFoundGood}</div>
            )}
            <div><span className="text-ink-muted">{d.f.observations}: </span>{audit.observations}</div>
          </div>
        )}
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{d.findingsTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{d.findingsIntro}</p>

        <div className="flex flex-col gap-3">
          {audit.findings.map((f) => {
            const canClose = !!f.correctiveAction;
            return (
              <form key={f.id} action={saveAuditFinding} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <input type="hidden" name="id" value={f.id} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-mono text-xs font-medium text-accent-strong" dir="ltr">{f.findingNumber}</span>
                  {f.isoClauseRef && <span className="font-mono text-xs text-ink-muted" dir="ltr">{f.isoClauseRef}</span>}
                  <span className={`${ui.chip} ${f.classification === "MAJOR" ? "bg-critical-soft text-critical" : f.classification === "MINOR" ? "bg-warn-soft text-warn" : "bg-surface-alt text-ink-muted"}`}>
                    {d.classificationLabel[f.classification as keyof typeof d.classificationLabel] ?? f.classification}
                  </span>
                  <span className={`${ui.chip} ${findingStatusChip[f.status] ?? ""}`}>
                    {d.findingStatusLabel[f.status as keyof typeof d.findingStatusLabel] ?? f.status}
                  </span>
                </div>
                <p className="text-sm">{f.description}</p>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={ui.label}>{d.f.correctiveAction}</label>
                    <textarea name="correctiveAction" defaultValue={f.correctiveAction ?? ""} rows={2} className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className={ui.label}>{d.f.responsibleId}</label>
                    <select name="responsibleId" defaultValue={f.responsibleId ?? ""} className={`${ui.select} w-full`}>
                      <option value="">{dict.field.none}</option>
                      {qualityUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={ui.label}>{d.f.dueDate}</label>
                    <input name="dueDate" type="date" defaultValue={f.dueDate ? new Date(f.dueDate).toISOString().slice(0, 10) : ""} className={`${ui.input} w-full`} />
                  </div>
                </div>
                {f.status !== "CLOSED" && (
                  <div className="flex items-center gap-2">
                    <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">{d.save}</button>
                    {canClose && (
                      <button formAction={closeAuditFinding} className="rounded-md border border-good bg-good-soft px-3 py-1.5 text-xs font-medium text-good hover:opacity-80">
                        {d.close}
                      </button>
                    )}
                    {!canClose && <span className="text-xs text-ink-muted">{d.closeHint}</span>}
                  </div>
                )}
              </form>
            );
          })}
          {audit.findings.length === 0 && <p className="text-sm text-ink-muted">{d.emptyFindings}</p>}
        </div>

        <form action={addAuditFinding} className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          <h2 className="font-display text-base font-semibold">{d.newFindingTitle}</h2>
          <input type="hidden" name="auditId" value={audit.id} />
          <div>
            <label className={ui.label}>{d.f.description}</label>
            <textarea name="description" required rows={2} className="w-full rounded-md border border-glass-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className={ui.label}>{d.f.classification}</label>
              <select name="classification" required className={ui.select}>
                {Object.entries(d.classificationLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className={ui.label}>{d.f.isoClauseRef}</label>
              <input name="isoClauseRef" className={ui.input} dir="ltr" placeholder="e.g. 8.5.1" />
            </div>
            <button type="submit" className={ui.button}>{d.addFinding}</button>
          </div>
        </form>
      </div>

      <Link href="/quality?tab=audits" className="text-sm font-medium text-accent-strong hover:underline">
        {d.back}
      </Link>
    </div>
  );
}
