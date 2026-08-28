import { redirect } from "next/navigation";

// Moved to warehouses/materials/[id] alongside the rest of the Raw
// Materials tab — see that page. This route stays only so any old
// bookmark still lands somewhere real.
export default async function StockLedgerDetailRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ site?: string }>;
}) {
  const { id } = await params;
  const { site } = await searchParams;
  redirect(`/warehouses/materials/${id}${site ? `?site=${site}` : ""}`);
}
