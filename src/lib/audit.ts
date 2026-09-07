import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

/**
 * Records an immutable audit event. Per the Batchline design spec, every
 * write to a priced, weighed, or certified record logs who/what/when.
 * Actor and role are pulled from the current session automatically — a
 * machine-triggered write with no session (the SCADA/GPS webhooks) resolves
 * to role "SYSTEM" on its own. Pass `role` explicitly only to override that.
 */
export async function logAudit(params: {
  module: string;
  recordId: string;
  field?: string;
  beforeValue?: string;
  afterValue?: string;
  reasonCode?: string;
  role?: string;
}) {
  const user = params.role ? null : await getCurrentUser();

  await prisma.auditEvent.create({
    data: {
      actorId: user?.id,
      module: params.module,
      recordId: params.recordId,
      field: params.field,
      beforeValue: params.beforeValue,
      afterValue: params.afterValue,
      reasonCode: params.reasonCode,
      role: params.role ?? user?.role ?? "SYSTEM",
    },
  });
}

// PL-R6-P2-01, sixth production-lifecycle review: logAudit above always
// reads the CURRENT session and always writes through the plain
// singleton `prisma`, never a transaction client — fine for a genuinely
// post-commit log, wrong for any command whose business mutation and
// audit record must succeed or fail together. writeAudit takes the
// actor as a plain argument (never touches the session itself) and the
// SAME transaction client the business write already used, so a failure
// on this insert (a bad actorId FK, say) rolls back the mutation with
// it instead of leaving a business change with no audit trail, and a
// caller can never accidentally show the requester a "failed" result
// for a business write that actually already committed.
export async function writeAudit(
  tx: Prisma.TransactionClient,
  actor: { id: string | null; role: string },
  event: {
    module: string;
    recordId: string;
    field?: string;
    beforeValue?: string;
    afterValue?: string;
    reasonCode?: string;
  },
) {
  await tx.auditEvent.create({
    data: {
      actorId: actor.id,
      role: actor.role,
      module: event.module,
      recordId: event.recordId,
      field: event.field,
      beforeValue: event.beforeValue,
      afterValue: event.afterValue,
      reasonCode: event.reasonCode,
    },
  });
}
