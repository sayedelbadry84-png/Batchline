import { Prisma } from "@prisma/client";
export type BillingCode = "INVALID_INPUT" | "INVOICE_NOT_PAYABLE" | "EXCEEDS_AMOUNT_DUE" | "CONCURRENT_CONFLICT" | "NOT_AUTHORIZED";
export type BillingResult = { ok: true } | { ok: false; code: BillingCode };
export class BillingRejection extends Error {
  constructor(public readonly code: BillingCode) { super(code); }
}
export function billingFailure(error: unknown): BillingResult {
  if (error instanceof BillingRejection) return { ok: false, code: error.code };
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return { ok: false, code: "CONCURRENT_CONFLICT" };
  console.error("Unexpected billing transaction failure", { type: error instanceof Error ? error.name : "Unknown" });
  throw error;
}
