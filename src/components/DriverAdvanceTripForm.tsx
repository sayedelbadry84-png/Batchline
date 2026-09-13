"use client";

import { useActionState } from "react";
import { driverAdvanceTrip } from "@/app/driver/actions";

export type DriverAdvanceTripMessages = {
  buttonLabel: string;
  errors: Record<string, string>;
};

// Was a plain <form action={driverAdvanceTrip}> — driverAdvanceTrip
// itself discarded advanceTripBase's typed result (PL-R5-P2-04, fifth
// production-lifecycle review), so a rejected advance just reloaded the
// page with nothing visible. Same useActionState shape as the desktop
// Trip Board's AdvanceTripForm.tsx.
export function DriverAdvanceTripForm({
  tripId,
  expectedStatus,
  buttonClassName,
  messages,
}: {
  tripId: string;
  expectedStatus: string;
  buttonClassName: string;
  messages: DriverAdvanceTripMessages;
}) {
  const [state, formAction, isPending] = useActionState(driverAdvanceTrip, null);
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
