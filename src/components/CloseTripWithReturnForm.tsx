"use client";

import { useActionState } from "react";
import { closeTripWithReturn } from "@/app/(app)/trips/actions";

export type CloseTripWithReturnMessages = {
  returnPlaceholder: string;
  returnReasonPlaceholder: string;
  returnFatePlaceholder: string;
  buttonLabel: string;
  errors: Record<string, string>;
};

// Same useActionState conversion as AdvanceTripForm.tsx (PL-R3-P2-01) —
// a rejected return-close (an invalid/missing reason, a returned volume
// over the ticket's own, or the trip having moved on) used to look
// exactly like a no-op.
export function CloseTripWithReturnForm({
  tripId,
  returnReasons,
  returnFates,
  messages,
  className,
  inputClassName,
  buttonClassName,
}: {
  tripId: string;
  returnReasons: Record<string, string>;
  returnFates: Record<string, string>;
  messages: CloseTripWithReturnMessages;
  className: string;
  inputClassName: string;
  buttonClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(closeTripWithReturn, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className={className}>
        <input type="hidden" name="tripId" value={tripId} />
        <input name="returnedVolumeM3" type="number" step="0.1" placeholder={messages.returnPlaceholder} required className={inputClassName} />
        <select name="reasonCode" defaultValue="" className={inputClassName}>
          <option value="">{messages.returnReasonPlaceholder}</option>
          {Object.entries(returnReasons).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select name="fate" defaultValue="" className={inputClassName}>
          <option value="">{messages.returnFatePlaceholder}</option>
          {Object.entries(returnFates).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button disabled={isPending} className={buttonClassName}>
          {messages.buttonLabel}
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
