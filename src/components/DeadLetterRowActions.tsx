"use client";

import { useActionState } from "react";
import { requeueDeadLetterAction, dismissDeadLetterAction, type DeadLetterActionState } from "@/app/(app)/queues/actions";

// PL-R12-P2-03, twelfth production-lifecycle review: the requeue/dismiss
// controls for one dead-lettered row. Typed useActionState results rather
// than void actions — a requeue that did nothing because another operator
// already handled the row is a refusal the person pressing the button has
// to see (AGENTS.md's own typed-action rule).
export function DeadLetterRowActions({
  kind,
  id,
  canRequeue,
  canDismiss,
  messages,
}: {
  kind: string;
  id: string;
  canRequeue: boolean;
  canDismiss: boolean;
  messages: { requeue: string; dismiss: string; notFound: string; notDeadLettered: string; invalid: string };
}) {
  const [requeueState, requeue, requeuePending] = useActionState(requeueDeadLetterAction, null as DeadLetterActionState);
  const [dismissState, dismiss, dismissPending] = useActionState(dismissDeadLetterAction, null as DeadLetterActionState);
  const state = requeueState ?? dismissState;
  const error = state && state.status !== "OK" ? (state.status === "NOT_FOUND" ? messages.notFound : state.status === "NOT_DEAD_LETTERED" ? messages.notDeadLettered : messages.invalid) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {canRequeue && (
          <form action={requeue}>
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={requeuePending} className="text-xs font-medium text-accent-strong hover:underline disabled:opacity-60">
              {messages.requeue}
            </button>
          </form>
        )}
        {canDismiss && (
          <form action={dismiss}>
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={dismissPending} className="text-xs font-medium text-critical hover:underline disabled:opacity-60">
              {messages.dismiss}
            </button>
          </form>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
