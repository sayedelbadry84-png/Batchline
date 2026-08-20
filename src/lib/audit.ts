import { prisma } from "@/lib/prisma";

/**
 * Records an immutable audit event. Per the Batchline design spec, every
 * write to a priced, weighed, or certified record logs who/what/when —
 * actor is nullable for now since auth/session wiring lands in a later phase.
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
  await prisma.auditEvent.create({
    data: {
      module: params.module,
      recordId: params.recordId,
      field: params.field,
      beforeValue: params.beforeValue,
      afterValue: params.afterValue,
      reasonCode: params.reasonCode,
      role: params.role ?? "SYSTEM",
    },
  });
}
