import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";

const WINDOW_MINUTES = 15;
// Deliberately higher than User.failedLoginAttempts' per-account threshold
// (5) — an IP can legitimately be a shared plant-office network with
// several real people typing wrong passwords independently; this exists
// to catch one source spraying guesses across many different accounts,
// not to double-punish ordinary mistakes.
const MAX_ATTEMPTS_PER_IP = 20;

export async function getClientIp(): Promise<string> {
  const h = await headers();
  // Vercel (and most proxies) set x-forwarded-for as "client, proxy1, proxy2...".
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return h.get("x-real-ip") ?? "unknown";
}

export async function isIpRateLimited(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
  const count = await prisma.loginAttempt.count({ where: { ipAddress: ip, createdAt: { gte: since } } });
  return count >= MAX_ATTEMPTS_PER_IP;
}

export async function recordFailedAttempt(ip: string): Promise<void> {
  await prisma.loginAttempt.create({ data: { ipAddress: ip } });
  // Opportunistic cleanup — no cron needed at this table's size, just
  // trim anything outside even a generous multiple of the window on
  // whatever request happens to write next.
  const staleCutoff = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000 * 4);
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: staleCutoff } } }).catch(() => {});
}
