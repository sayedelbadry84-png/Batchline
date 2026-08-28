import { redirect } from "next/navigation";

// Moved to Finance's own namespace alongside the rest of Billing — see
// billing/page.tsx's redirect for why. Kept here only so an old bookmark
// or the dashboard's overdue-invoice alert link (before it's updated)
// still lands somewhere real.
export default async function InvoiceDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/finance/invoices/${id}`);
}
