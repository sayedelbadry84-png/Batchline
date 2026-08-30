import { prisma } from "@/lib/prisma";

/**
 * The one entry point any server action calls to raise an in-app
 * notification — see Notification's model comment in schema.prisma for
 * the engine's overall shape and scope. A no-op on an empty recipient
 * list rather than a wasted round trip.
 */
export async function notify(userIds: string[], params: { title: string; body?: string; link?: string; module: string }): Promise<void> {
  if (userIds.length === 0) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({ userId, ...params })),
  });
}

/**
 * Resolves a role list to active users first, then notifies them — same
 * "who's allowed to do X" role-list pattern every ACTION_ROLES/
 * REQUISITION_APPROVAL_ROLES gate already uses elsewhere, just read here
 * instead of enforced.
 */
export async function notifyRoles(roles: readonly string[], params: { title: string; body?: string; link?: string; module: string }): Promise<void> {
  const users = await prisma.user.findMany({ where: { role: { in: [...roles] }, status: "ACTIVE" }, select: { id: true } });
  await notify(users.map((u) => u.id), params);
}
