"use client";

import { useActionState } from "react";
import { decideWasteMemo } from "@/app/(app)/quality/actions";

export type DecideWasteMemoMessages = {
  noteLabel: string;
  notePlaceholder: string;
  approveLabel: string;
  denyLabel: string;
  errors: Record<string, string>;
};

// Was a plain <form action={approveWasteMemo}> with a second button
// overriding formAction to denyWasteMemo — every rejected decision
// (ALREADY_DECIDED if someone else got there first, NOT_FOUND if the
// memo fell out of scope) used to be indistinguishable from nothing
// happening (PL-R3-P2-01, third production-lifecycle review). One
// useActionState hook drives both buttons — `decision` names which one
// was pressed (see decideWasteMemo, quality/actions.ts).
export function DecideWasteMemoForm({ memoId, messages, labelClassName, textareaClassName, denyButtonClassName, approveButtonClassName }: {
  memoId: string;
  messages: DecideWasteMemoMessages;
  labelClassName: string;
  textareaClassName: string;
  denyButtonClassName: string;
  approveButtonClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(decideWasteMemo, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={memoId} />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className={labelClassName}>{messages.noteLabel}</label>
          <textarea name="approvalNote" required rows={2} placeholder={messages.notePlaceholder} className={textareaClassName} />
        </div>
        <button type="submit" name="decision" value="DENY" disabled={isPending} className={denyButtonClassName}>
          {messages.denyLabel}
        </button>
        <button type="submit" name="decision" value="APPROVE" disabled={isPending} className={approveButtonClassName}>
          {messages.approveLabel}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
    </form>
  );
}
