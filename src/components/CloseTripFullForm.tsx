"use client";

import { useActionState } from "react";
import { closeTripFull } from "@/app/(app)/trips/actions";

export type CloseTripFullMessages = {
  buttonLabel: string;
  errors: Record<string, string>;
};

// Same useActionState conversion as AdvanceTripForm.tsx, for the same
// reason (PL-R3-P2-01) — a refused close (most commonly NOT_DISCHARGING,
// if the trip moved on in the gap since the page loaded) used to be
// indistinguishable from the button doing nothing at all.
export function CloseTripFullForm({ tripId, buttonClassName, messages }: { tripId: string; buttonClassName: string; messages: CloseTripFullMessages }) {
  const [state, formAction, isPending] = useActionState(closeTripFull, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction}>
      <input type="hidden" name="tripId" value={tripId} />
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
