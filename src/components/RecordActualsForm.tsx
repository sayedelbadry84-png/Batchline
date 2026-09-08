"use client";

import { useActionState } from "react";
import { recordActuals, type RecordActualsActionState } from "@/app/(app)/production/actions";

export type RecordActualsMessages = {
  staleConflict: string;
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

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="batchTicketId" value={ticketId} />
      {state?.status === "STALE_READING" && (
        <p role="alert" className="mb-3 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
          {messages.staleConflict}
        </p>
      )}
      {children}
    </form>
  );
}
