import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resolveClientIp } from "@/lib/clientIp";

const WINDOW_MINUTES = 15;
// Deliberately higher than User.failedLoginAttempts' per-account threshold
// (5) — an IP can legitimately be a shared plant-office network with
// several real people typing wrong passwords independently; this exists
// to catch one source spraying guesses across many different accounts,
// not to double-punish ordinary mistakes.
const MAX_ATTEMPTS_PER_IP = 20;

export async function getClientIp(): Promise<string> {
  const h = await headers();
  // The trust decision lives in src/lib/clientIp.ts, away from the
  // request plumbing, so it can be tested against crafted headers
  // without a server.
  return resolveClientIp((name) => h.get(name));
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
