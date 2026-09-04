"use client";

import { useActionState } from "react";
import { completeBatch, type CompleteBatchActionState } from "@/app/(app)/production/actions";

export type CompleteBatchMessages = {
  completeTitle: string;
  completeIntro: string;
  completeButton: string;
  shortageOverrideNote: string;
  shortageOverrideNotePlaceholder: string;
  shortageOverrideNoteHint: string;
  errorInsufficientStock: string;
  errorStorageNotConfigured: string;
  errorAlreadyCompleted: string;
  errorInvalidState: string;
  errorConcurrentConflict: string;
  errorUnauthorizedOverride: string;
  errorNotFound: string;
};

function errorText(state: NonNullable<CompleteBatchActionState>, m: CompleteBatchMessages): string | null {
  switch (state.status) {
    case "SUCCESS":
      return null;
    case "INSUFFICIENT_STOCK":
      return m.errorInsufficientStock;
    case "STORAGE_NOT_CONFIGURED":
      return m.errorStorageNotConfigured;
    case "ALREADY_COMPLETED":
      return m.errorAlreadyCompleted;
    case "INVALID_STATE":
      return m.errorInvalidState;
    case "CONCURRENT_CONFLICT":
      return m.errorConcurrentConflict;
    case "UNAUTHORIZED_OVERRIDE":
      return m.errorUnauthorizedOverride;
    case "NOT_FOUND":
      return m.errorNotFound;
  }
}

// Was a plain <form action={completeBatch}> — every rejected completion
// (insufficient stock, no matching storage, a concurrent conflict, ...)
// used to just silently do nothing, per HI-05 in the Phase 1 review. Now
// a Client Component so useActionState can render the actual reason.
// showShortageField is false on the mobile/operator ticket view, which
// never offered the override note in the first place.
export function CompleteBatchForm({
  ticketId,
  messages,
  showShortageField,
  cardClassName,
  titleClassName,
  introClassName,
  buttonClassName,
  labelClassName,
  inputClassName,
  hintClassName,
}: {
  ticketId: string;
  messages: CompleteBatchMessages;
  showShortageField: boolean;
  cardClassName: string;
  titleClassName: string;
  introClassName: string;
  buttonClassName: string;
  labelClassName: string;
  inputClassName: string;
  hintClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(completeBatch, null);
  const error = state ? errorText(state, messages) : null;

  return (
    <form action={formAction} className={cardClassName}>
      <input type="hidden" name="batchTicketId" value={ticketId} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className={titleClassName}>{messages.completeTitle}</h2>
          <p className={introClassName}>{messages.completeIntro}</p>
        </div>
        <button type="submit" disabled={isPending} className={buttonClassName}>
          {messages.completeButton}
        </button>
      </div>
      {showShortageField && (
        <div>
          <label className={labelClassName}>{messages.shortageOverrideNote}</label>
          <textarea name="shortageOverrideNote" rows={2} placeholder={messages.shortageOverrideNotePlaceholder} className={inputClassName} />
          <p className={hintClassName}>{messages.shortageOverrideNoteHint}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
          {state?.detail ? `: ${state.detail}` : ""}
        </p>
      )}
    </form>
  );
}
