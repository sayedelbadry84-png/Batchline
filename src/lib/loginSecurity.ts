import "server-only";
import { prisma } from "@/lib/prisma";
import { matchingTotpStep } from "@/lib/totp";

// A read-then-write increment loses concurrent failures and can prevent
// the lockout from ever firing. The increment holds the user row lock
// until the conditional lockout update commits in the same transaction.
export async function recordAccountFailure(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { failedLoginAttempts: { increment: 1 } } });
    await tx.user.updateMany({
      where: { id: userId, failedLoginAttempts: { gte: 5 } },
      data: { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) },
    });
  });
}

// The step is claimed atomically across every pending login/browser.
// Checking a code alone is not enough: it is otherwise reusable for the
// entire drift window, even after an earlier login already consumed it.
export async function consumeTotpCode(userId: string, secret: string, code: string): Promise<boolean> {
  const step = matchingTotpStep(secret, code);
  if (step === null) return false;
  const claim = await prisma.user.updateMany({
    where: {
      id: userId, status: "ACTIVE", totpEnabled: true, totpSecret: secret,
      AND: [
        { OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
        { OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
      ],
    },
    data: { totpLastUsedStep: step, failedLoginAttempts: 0, lockedUntil: null },
  });
  return claim.count === 1;
}
