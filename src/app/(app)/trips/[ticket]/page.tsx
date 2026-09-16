import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/session";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";

// A trip permalink. /trips/BT-2026-0020 used to 404: a trip has never had
// a page of its own, because everything a dispatcher does to one — load,
// dispatch, advance, close with or without a return — hangs off its batch
// ticket, and that page already exists at /production/[id]. What was
// missing was an address a person can actually type or paste: the ticket
// NUMBER printed on the delivery note, not the internal id.
//
// So this resolves rather than duplicates. It accepts either the ticket
// number or the id, scopes the lookup to the caller's own site INSIDE the
// query (AGENTS.md rule 2 — an out-of-scope ticket is indistinguishable
// from one that does not exist), and hands over to the one real page.
export default async function TripPermalinkPage({ params }: { params: Promise<{ ticket: string }> }) {
  const user = await requirePageAccess("trips");
  const { ticket: raw } = await params;
  const key = decodeURIComponent(raw).trim();
  if (!key) notFound();

  const ticket = await prisma.batchTicket.findFirst({
    where: { OR: [{ ticketNumber: key }, { id: key }], ...plantScopeWhere(effectiveSiteId(user)) },
    select: { id: true },
  });
  if (!ticket) notFound();

  redirect(`/production/${ticket.id}`);
}
