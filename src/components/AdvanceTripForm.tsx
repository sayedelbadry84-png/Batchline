"use client";

import { useActionState } from "react";
import { advanceTrip } from "@/app/(app)/trips/actions";

export type AdvanceTripMessages = {
  buttonLabel: string;
  errors: Record<string, string>;
};

// Was a plain <form action={advanceTrip}> — every rejected advance
// (STALE_STATE from a duplicate/late request, NOT_FOUND from a scope or
// ownership mismatch, ...) used to just silently do nothing (PL-R3-P2-01,
// third production-lifecycle review, repeating the same gap from the two
// reviews before it). Same useActionState shape as CompleteBatchForm.tsx.
export function AdvanceTripForm({
  tripId,
  expectedStatus,
  buttonClassName,
  messages,
}: {
  tripId: string;
  expectedStatus: string;
  buttonClassName: string;
  messages: AdvanceTripMessages;
}) {
  const [state, formAction, isPending] = useActionState(advanceTrip, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction}>
      <input type="hidden" name="tripId" value={tripId} />
      <input type="hidden" name="expectedStatus" value={expectedStatus} />
      <button disabled={isPending} className={buttonClassName}>
        {messages.buttonLabel}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-critical">
          {error}
        </p>
      )}
    </form>
  );
}
