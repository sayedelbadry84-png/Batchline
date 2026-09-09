import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { canPerformAction } from "@/lib/permissions";
import { getDictionary } from "@/lib/i18n";
import { effectiveSiteId } from "@/lib/siteScope";
import { listDeadLetters } from "@/lib/deadLetterQueue";
import { DeadLetterRowActions } from "@/components/DeadLetterRowActions";

// PL-R12-P2-03, twelfth production-lifecycle review: both retry queues
// could park a row as dead-lettered, but nothing ever showed those rows
// to a human and no action could requeue or drop one — a real abandoned
// consequence (a purchasing requisition never opened, an orphaned
// delivery photo never cleaned up) whose only evidence was a console
// line. Site scoping and the two state transitions live in
// src/lib/deadLetterQueue.ts; this page only renders them.
export default async function QueuesPage() {
  const user = await requirePageAccess("queues");
  const { dict } = await getDictionary();
  const m = dict.modules.queues;

  const allowedSiteId = effectiveSiteId(user);
  const [rows, canRequeue, canDismiss] = await Promise.all([
    listDeadLetters(allowedSiteId),
    canPerformAction(user!.role, "queues", "requeueDeadLetter"),
    canPerformAction(user!.role, "queues", "dismissDeadLetter"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <section className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">
          {m.deadLetters} ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">{m.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.col.kind}</th>
                  <th className={ui.th}>{m.col.subject}</th>
                  <th className={ui.th}>{m.col.reason}</th>
                  <th className={ui.th}>{m.col.attempts}</th>
                  <th className={ui.th}>{m.col.lastError}</th>
                  <th className={ui.th}>{m.col.deadLetteredAt}</th>
                  {(canRequeue || canDismiss) && <th className={ui.th}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td className={ui.td}>{m.kinds[row.kind]}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">
                      {row.subject}
                    </td>
                    <td className={ui.td}>{m.reasons[row.reason as keyof typeof m.reasons] ?? row.reason}</td>
                    <td className={`${ui.td} font-mono tabular`}>{row.attempts}</td>
                    <td className={`${ui.td} max-w-md truncate text-xs text-ink-muted`} title={row.lastError ?? ""} dir="ltr">
                      {row.lastError}
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">
                      {row.deadLetteredAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    {(canRequeue || canDismiss) && (
                      <td className={ui.td}>
                        <DeadLetterRowActions
                          kind={row.kind}
                          id={row.id}
                          canRequeue={canRequeue}
                          canDismiss={canDismiss}
                          messages={{
                            requeue: m.requeue,
                            dismiss: m.dismiss,
                            notFound: m.errorNotFound,
                            notDeadLettered: m.errorNotDeadLettered,
                            invalid: m.errorInvalid,
                          }}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-muted">{m.scopeNote}</p>
      </section>
    </div>
  );
}
