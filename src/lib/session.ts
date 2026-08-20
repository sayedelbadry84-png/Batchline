import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const SESSION_COOKIE = "batchline_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(userId: string) {
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, session.id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    expires: session.expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { id: token } });
  }
  store.delete(SESSION_COOKIE);
}

// Safe to call from Server Components (read-only cookie access) as well as
// Server Actions. Expired sessions are lazily cleaned up on lookup.
export async function getCurrentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { id: token },
    include: { user: { include: { employee: true, plant: true } } },
  });
  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: token } }).catch(() => {});
    return null;
  }

  return session.user;
}

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/**
 * Gate a Server Action to a set of roles. Throws rather than redirecting —
 * Server Actions don't have a flash-message channel yet, so a role
 * violation surfaces as a Next.js error boundary rather than a friendly
 * inline message. Good enough to make the boundary real; a toast/error
 * banner is a follow-up.
 */
export function requireRole(user: CurrentUser | null, allowed: string[]) {
  if (!user) throw new Error("Not authenticated.");
  if (!allowed.includes(user.role)) {
    throw new Error(`Role ${user.role} is not permitted to perform this action.`);
  }
}
