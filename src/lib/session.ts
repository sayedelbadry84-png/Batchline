import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canAccessModule, canPerformAction, type ModuleKey, type ActionModuleKey } from "@/lib/permissions";

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
    // Never send the session cookie over a plain-HTTP fallback once this is
    // reachable beyond localhost — NODE_ENV is "production" for `next
    // build`/`next start` (what a real deployment runs), "development" for
    // `next dev`, so this stays off for local HTTP dev without needing a
    // separate flag to remember to flip.
    secure: process.env.NODE_ENV === "production",
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

// A password has verified but the account also needs a TOTP code — this
// cookie carries an opaque, server-generated PendingTwoFactor row id across
// the redirect to /login/verify, NEVER the user id itself: httpOnly only
// keeps JS from reading it, it doesn't stop a client from handcrafting an
// arbitrary cookie value in a raw request, so if the cookie's value were the
// user id directly, anyone who knew or guessed a valid user id could skip
// the password step entirely and start attempting TOTP codes for that
// account. A random cuid the client never chooses closes that off. Kept in
// its own table rather than the Session table so nothing else in the app
// could ever mistake a pending-2FA state for an actual logged-in session.
// Short-lived on purpose: the user either finishes 2FA within 5 minutes or
// starts over.
const PENDING_2FA_COOKIE = "batchline_pending_2fa";
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

export async function setPending2faUser(userId: string) {
  const pending = await prisma.pendingTwoFactor.create({
    data: { userId, expiresAt: new Date(Date.now() + PENDING_2FA_TTL_MS) },
  });
  const store = await cookies();
  store.set(PENDING_2FA_COOKIE, pending.id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: PENDING_2FA_TTL_MS / 1000,
  });
}

export async function getPending2faUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(PENDING_2FA_COOKIE)?.value;
  if (!token) return null;

  const pending = await prisma.pendingTwoFactor.findUnique({ where: { id: token } });
  if (!pending) return null;

  if (pending.expiresAt < new Date()) {
    await prisma.pendingTwoFactor.delete({ where: { id: token } }).catch(() => {});
    return null;
  }

  return pending.userId;
}

export async function clearPending2fa() {
  const store = await cookies();
  const token = store.get(PENDING_2FA_COOKIE)?.value;
  if (token) {
    await prisma.pendingTwoFactor.deleteMany({ where: { id: token } });
  }
  store.delete(PENDING_2FA_COOKIE);
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

  // A session created while the account was ACTIVE stays valid for up to
  // SESSION_TTL_MS even after an admin disables/freezes the user — without
  // this check, revoking access only takes effect once the session
  // naturally expires (up to 7 days later), not immediately.
  if (session.user.status !== "ACTIVE") {
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

/**
 * Page-level counterpart to requireRole: call at the top of a Server
 * Component page to actually enforce what the sidebar only hints at by
 * hiding a link. A role that can't act on a module shouldn't be able to
 * read it either just because the (app) layout confirmed they're logged in.
 */
export async function requirePageAccess(moduleKey: ModuleKey) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!(await canAccessModule(user.role, moduleKey))) {
    redirect(`/access-denied?module=${moduleKey}`);
  }
  return user;
}

/**
 * Finer-grained sibling of requireRole, for the specific actions gated by
 * ActionPermission (src/lib/permissions.ts) instead of a hardcoded role
 * array — e.g. reservation approval, where the database-editable grant
 * (set from /permissions) is the actual source of truth, not a value
 * baked into this call site.
 */
export async function requireActionPermission(user: CurrentUser | null, moduleKey: ActionModuleKey, actionKey: string) {
  if (!user) throw new Error("Not authenticated.");
  if (!(await canPerformAction(user.role, moduleKey, actionKey))) {
    throw new Error(`Role ${user.role} is not permitted to perform "${actionKey}" in ${moduleKey}.`);
  }
}
