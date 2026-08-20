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
