"use client";

import { useActionState } from "react";
import { cancelBatchTicket, type CancelBatchTicketActionState } from "@/app/(app)/production/actions";

export type CancelBatchTicketMessages = {
  title: string;
  hint: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  confirmPrompt: string;
  button: string;
  errorInvalidState: string;
  errorNotFound: string;
};

function errorText(state: NonNullable<CancelBatchTicketActionState>, m: CancelBatchTicketMessages): string | null {
  switch (state.status) {
    case "SUCCESS":
      return null;
    case "INVALID_STATE":
      return m.errorInvalidState;
    case "NOT_FOUND":
      return m.errorNotFound;
  }
}

// The soft-cancel path for a non-terminal ticket that has a
// ShortageOverrideRequest on file (P2-01, fourth review) — shown INSTEAD
// of the plain "Delete ticket" form/button in that case, never alongside
// it, since deleteBatchTicket can no longer actually delete such a ticket
// (that request's own FK is ON DELETE RESTRICT, deliberately, so an
// approval decision's history is never silently erased).
export function CancelBatchTicketForm({
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
  messages: CancelBatchTicketMessages;
  cardClassName: string;
  titleClassName: string;
  hintClassName: string;
  labelClassName: string;
  inputClassName: string;
  buttonClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(cancelBatchTicket, null);
  const error = state ? errorText(state, messages) : null;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm(messages.confirmPrompt)) e.preventDefault();
      }}
      className={cardClassName}
    >
      <input type="hidden" name="batchTicketId" value={ticketId} />
      <h2 className={titleClassName}>{messages.title}</h2>
      <p className={hintClassName}>{messages.hint}</p>
      <div>
        <label className={labelClassName}>{messages.reasonLabel}</label>
        <textarea name="reason" rows={2} required placeholder={messages.reasonPlaceholder} className={inputClassName} />
      </div>
      <button type="submit" disabled={isPending} className={buttonClassName}>
        {messages.button}
      </button>
      {error && <p role="alert" className="text-sm text-critical">{error}</p>}
    </form>
  );
}
