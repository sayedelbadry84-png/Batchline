import { prisma } from "@/lib/prisma";
import { sendPushToUser } from "@/lib/push";

/**
 * The one entry point any server action calls to raise a notification —
 * see Notification's model comment in schema.prisma for the in-app bell's
 * shape and scope. Every call here also fires a real Web Push to each
 * recipient's subscribed devices (src/lib/push.ts) — one entry point, so
 * every existing and future notify()/notifyRoles() call site gets actual
 * push notifications for free, rather than each having to separately
 * remember to call a push function too. sendPushToUser is a no-op per
 * user with no subscription (most users, until they opt in) or with VAPID
 * unconfigured, and never throws — a push hiccup never breaks the
 * business action that triggered it. A no-op on an empty recipient list
 * rather than a wasted round trip.
 */
export async function notify(userIds: string[], params: { title: string; body?: string; link?: string; module: string }): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, ...params })),
  });
  await Promise.all(userIds.map((userId) => sendPushToUser(userId, { title: params.title, body: params.body, link: params.link })));
}

/**
 * Resolves a role list to active users first, then notifies them — same
 * "who's allowed to do X" role-list pattern every ACTION_ROLES/
 * REQUISITION_APPROVAL_ROLES gate already uses elsewhere, just read here
 * instead of enforced.
 *
 * siteId narrows recipients to that one site (ADMIN always included
 * regardless, same "ADMIN sees every site" rule effectiveSiteId itself
 * uses in siteScope.ts) — omit it (as every call site before this one
 * still does) to keep the existing org-wide broadcast. Added for a real
 * cross-site leak an external review caught on the shortage-override
 * notification specifically: a plant-scoped manager at Site B was being
 * notified about a request raised at Site A. The other org-wide
 * notifyRoles call sites (requisition approval, purchasing, quality,
 * driver) are unchanged — narrowing those too is a separate, broader
 * decision this fix doesn't make on their behalf.
 */
export async function notifyRoles(
  roles: readonly string[],
  params: { title: string; body?: string; link?: string; module: string },
  opts?: { siteId?: string | null },
): Promise<void> {
  const where =
    opts?.siteId != null
      ? { role: { in: [...roles] }, status: "ACTIVE" as const, OR: [{ role: "ADMIN" }, { plant: { siteId: opts.siteId } }] }
      : { role: { in: [...roles] }, status: "ACTIVE" as const };
  const users = await prisma.user.findMany({ where, select: { id: true } });
  await notify(users.map((u) => u.id), params);
}
