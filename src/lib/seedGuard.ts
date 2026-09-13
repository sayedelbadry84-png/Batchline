// PR4-R4-P1-01, external-review validation round 4 (2026-09-10).
//
// Hiding the credential panel on the login page removed the advertisement,
// not the credential. prisma/seed.ts is in a public repository, is wired
// into `package.json` as the standard `prisma db seed` command, and
// created six ACTIVE users — an administrator among them — all sharing one
// password that anyone can read in the source. Nothing stopped it running
// against a production database.
//
// This is the gate it now has to pass. Two independent conditions, both
// required, because either one alone is easy to satisfy by accident:
//
//  - NODE_ENV must not be "production" — catches the ordinary mistake of
//    running the seed on a deployed box;
//  - ALLOW_DEMO_SEED must be set to an exact phrase that cannot be typed
//    absent-mindedly, and that says out loud what the seed does — it
//    creates demo accounts with a password published in the repository.
//
// A DATABASE_URL check is deliberately NOT part of this: the connection
// string of a production database looks like any other, and a guard that
// pretends to recognise one would be false assurance.
export const DEMO_SEED_OPT_IN = "yes-create-demo-accounts-with-a-public-password";

export type SeedGuardResult = { status: "ALLOWED" } | { status: "REFUSED"; reason: string };

export function checkDemoSeedAllowed(env: { NODE_ENV?: string; ALLOW_DEMO_SEED?: string }): SeedGuardResult {
  if (env.NODE_ENV === "production") {
    return {
      status: "REFUSED",
      reason:
        "NODE_ENV is \"production\". This seed creates demo accounts whose password is published in this repository; it must never run against a production database.",
    };
  }
  if (env.ALLOW_DEMO_SEED !== DEMO_SEED_OPT_IN) {
    return {
      status: "REFUSED",
      reason: `Refusing to seed demo data without an explicit opt-in. Set ALLOW_DEMO_SEED="${DEMO_SEED_OPT_IN}" to confirm you are pointing at a throwaway development database.`,
    };
  }
  return { status: "ALLOWED" };
}
