"use client";

import { useActionState } from "react";
import { markDrumReturnFate } from "@/app/(app)/trips/actions";

export type MarkDrumReturnFateMessages = {
  reclaimedLabel: string;
  dumpedLabel: string;
  errors: Record<string, string>;
};

// Was a plain <form action={markDrumReturnFate}> with two named-value
// submit buttons — a refused decision (NOT_ELIGIBLE for a full-waste
// return, ALREADY_SET/ALREADY_CONSUMED for a one-way decision already
// made) used to just silently do nothing (PL-R3-P2-01, third production-
// lifecycle review). Shared by both trips/page.tsx and reports/page.tsx,
// the two places this same form already existed.
export function MarkDrumReturnFateForm({
  drumReturnId,
  className,
  reclaimedButtonClassName,
  dumpedButtonClassName,
  messages,
}: {
  drumReturnId: string;
  className: string;
  reclaimedButtonClassName: string;
  dumpedButtonClassName: string;
  messages: MarkDrumReturnFateMessages;
}) {
  const [state, formAction, isPending] = useActionState(markDrumReturnFate, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="id" value={drumReturnId} />
      <button name="fate" value="RECLAIMED" disabled={isPending} className={reclaimedButtonClassName}>
        {messages.reclaimedLabel}
      </button>
      <button name="fate" value="DUMPED" disabled={isPending} className={dumpedButtonClassName}>
        {messages.dumpedLabel}
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-critical">
          {error}
        </p>
      )}
    </form>
  );
}
