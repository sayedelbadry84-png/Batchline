// Banner text for the `customerResult` query parameter the credit limit
// request actions redirect with (customers/actions.ts). Only a submitted,
// approved or rejected request reads as a success; an unknown code (a
// hand-edited URL) renders nothing.
export type CreditLimitResultMessages = {
  REQUESTED: string;
  APPROVED: string;
  REJECTED: string;
  STALE: string;
  FORBIDDEN: string;
  NOT_FOUND: string;
  INVALID_AMOUNT: string;
  NOT_AN_INCREASE: string;
  REASON_REQUIRED: string;
  ALREADY_PENDING: string;
  NOT_PENDING: string;
  SELF_DECISION: string;
  NOTE_REQUIRED: string;
  NO_ELIGIBLE_APPROVER: string;
  FAILED: string;
};

const SUCCESS = new Set(["REQUESTED", "APPROVED", "REJECTED"]);

export function describeCustomerResult(messages: CreditLimitResultMessages, code: string | undefined): { text: string; ok: boolean } | null {
  if (!code || !Object.hasOwn(messages, code)) return null;
  return { text: messages[code as keyof CreditLimitResultMessages], ok: SUCCESS.has(code) };
}
