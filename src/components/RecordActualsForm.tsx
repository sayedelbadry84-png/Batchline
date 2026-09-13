"use client";

import { useActionState } from "react";
import { recordActuals, type RecordActualsActionState } from "@/app/(app)/production/actions";

// PL-R12-P2-01, twelfth production-lifecycle review: only STALE_READING
// was ever rendered. A ticket going COMPLETE/CANCELLED while readings are
// being entered is an ordinary production race, and it refuses the WHOLE
// bulk submit — so the operator pressed "Save readings", nothing was
// saved, and the page simply reloaded with no explanation at all. Every
// non-OK state now has its own text, plus a generic fallback so a status
// added later can never silently render as success.
export type RecordActualsMessages = {
  staleConflict: string;
  terminal: string;
  notFound: string;
  genericFailure: string;
};

// PL-R10-P1-04, tenth production-lifecycle review: was a plain
// <form action={recordActuals}> on both the production and operator
// ticket pages — a STALE_READING result (the whole bulk write rolled
// back, PL-R9-P1-03) had no way to reach either page at all. children is
// everything the two pages already render inside this form (the
// components table, hidden per-component version inputs, the "Save
// readings" submit button, the moisture hint) — kept as Server Component
// output rather than duplicated here, since only the FORM WRAPPER itself
// needed to become a Client Component to read useActionState.
// `action` is injectable (defaulting to the real Server Action), the same
// pattern already used for StorageAdapter (offlineQueue.ts) and
// BlobDeleter (blob.ts) — this is what makes the STALE_READING banner
// itself provable in a real rendered test without needing a live session/
// database, while production always gets the real recordActuals.
export function RecordActualsForm({
  ticketId,
  messages,
  className,
  children,
  action = recordActuals,
}: {
  ticketId: string;
  messages: RecordActualsMessages;
  className?: string;
  children: React.ReactNode;
  action?: (prevState: RecordActualsActionState, formData: FormData) => Promise<RecordActualsActionState>;
}) {
  const [state, formAction] = useActionState(action, null as RecordActualsActionState);
  const error = state === null || state.status === "OK" ? null : failureText(state.status, messages);

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="batchTicketId" value={ticketId} />
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      {children}
    </form>
  );
}

// Deliberately NOT an exhaustive switch over the union: a status added to
// RecordActualsActionState later must fall through to the generic
// message rather than render nothing, since rendering nothing is exactly
// the false-success behaviour this whole component exists to prevent.
function failureText(status: string, messages: RecordActualsMessages): string {
  switch (status) {
    case "STALE_READING":
      return messages.staleConflict;
    case "TERMINAL":
      return messages.terminal;
    case "NOT_FOUND":
      return messages.notFound;
    default:
      return messages.genericFailure;
  }
}
