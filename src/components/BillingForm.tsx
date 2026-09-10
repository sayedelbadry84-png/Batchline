"use client";
import { useActionState, type ReactNode } from "react";
import type { BillingResult } from "@/lib/billingResult";
const messages = {
  INVALID_INPUT: "بيانات غير صالحة / Invalid input",
  INVOICE_NOT_PAYABLE: "الفاتورة لا تقبل السداد / Invoice is not payable",
  EXCEEDS_AMOUNT_DUE: "المبلغ أكبر من المستحق / Amount exceeds balance due",
  CONCURRENT_CONFLICT: "تعارض متزامن؛ أعد المحاولة / Concurrent conflict; retry",
  NOT_AUTHORIZED: "الفاتورة خارج نطاق صلاحياتك / Invoice is outside your scope",
};
export function BillingForm({ action, children, className }: { action: (data: FormData) => Promise<BillingResult>; children: ReactNode; className?: string }) {
  const [state, dispatch, pending] = useActionState(async (_: BillingResult | null, data: FormData) => action(data), null);
  return <form action={dispatch} className={className}>
    {state && !state.ok && <p role="alert" className="text-critical">{messages[state.code]}</p>}
    {state?.ok && <p role="status">تم الحفظ / Saved</p>}
    <fieldset disabled={pending} className="contents">{children}</fieldset>
  </form>;
}
