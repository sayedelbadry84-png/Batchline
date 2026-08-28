import { redirect } from "next/navigation";

// Merged into Finance as its "billing" tab — invoicing customers and
// paying suppliers are the two halves of the same AR/AP picture, so this
// no longer needs its own sidebar entry. This route stays only so any old
// bookmark still lands somewhere real.
export default function BillingPage() {
  redirect("/finance?tab=billing");
}
