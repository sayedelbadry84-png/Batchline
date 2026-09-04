"use client";

import { useActionState } from "react";
import { reverseBatchTicket, type ReverseBatchActionState } from "@/app/(app)/production/actions";

export type ReverseBatchMessages = {
  title: string;
  hint: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  confirmPrompt: string;
  button: string;
  errorInvalidState: string;
  errorAlreadyReversed: string;
  errorConcurrentConflict: string;
  errorCapacityExceeded: string;
  errorStorageNotConfigured: string;
  errorNotFound: string;
};

function errorText(state: NonNullable<ReverseBatchActionState>, m: ReverseBatchMessages): string | null {
  switch (state.status) {
    case "SUCCESS":
      return null;
    case "INVALID_STATE":
      return m.errorInvalidState;
    case "ALREADY_REVERSED":
      return m.errorAlreadyReversed;
    case "CONCURRENT_CONFLICT":
      return m.errorConcurrentConflict;
    case "CAPACITY_EXCEEDED":
      return m.errorCapacityExceeded;
    case "STORAGE_NOT_CONFIGURED":
      return m.errorStorageNotConfigured;
    case "NOT_FOUND":
      return m.errorNotFound;
  }
}

// New — per HI-06 in the Phase 1 review, reverseBatchTicket (src/lib/
// batchCompletion.ts) had no UI at all before this, callable only as a
// bare Server Action. ADMIN-only (see production.reverseBatch in
// src/lib/permissions.ts), so this only ever renders for an ADMIN
// session — ui.button below stays visually consistent with the rest of
// the ticket page, not a special "danger" treatment, since a reversal is
// a legitimate documented correction, not a destructive delete.
export function ReverseBatchForm({
  ticketId,
  messages,
  cardClassName,
  titleClassName,
  hintClassName,
  labelClassName,
  inputClassName,
  buttonClassName,
}: {
  ticketId: string;
  messages: ReverseBatchMessages;
  cardClassName: string;
  titleClassName: string;
  hintClassName: string;
  labelClassName: string;
  inputClassName: string;
  buttonClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(reverseBatchTicket, null);
  const error = state ? errorText(state, messages) : null;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(messages.confirmPrompt)) e.preventDefault();
      }}
      className={cardClassName}
    >
      <input type="hidden" name="id" value={ticketId} />
      <h2 className={titleClassName}>{messages.title}</h2>
      <p className={hintClassName}>{messages.hint}</p>
      <div>
        <label className={labelClassName}>{messages.reasonLabel}</label>
        <textarea name="reason" rows={2} required placeholder={messages.reasonPlaceholder} className={inputClassName} />
      </div>
      <button type="submit" disabled={isPending} className={buttonClassName}>
        {messages.button}
      </button>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
          {state?.detail ? `: ${state.detail}` : ""}
        </p>
      )}
    </form>
  );
}
