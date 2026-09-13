import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// BL-CR-P1-05, external-review validation (2026-09-10): session and
// pending-2FA cookies used to carry the database row's own `cuid()` id as
// the bearer credential.
//
// Two separate problems with that. First, CUID is a collision-resistant
// IDENTIFIER, not a secret: the project itself is deprecated for security
// use and states that it leaks its creation timestamp, so the value is
// neither uniformly random nor of a stated entropy. Second — and
// independent of how guessable it is — a row id is the sort of value that
// legitimately appears in logs, error messages, admin screens and support
// tickets, because nothing about it announces that holding it IS being
// signed in.
//
// What replaces it: 32 bytes from the CSPRNG (256 bits, comfortably above
// the 128 OWASP asks for), base64url-encoded, handed to the browser and
// never stored. The database keeps only SHA-256 of it, so a leaked
// database dump does not yield usable session cookies. No salt and no
// slow KDF on purpose: the input is already high-entropy random, so there
// is no dictionary to attack and nothing for a work factor to buy — the
// hash exists to make the stored value non-reversible, not to resist
// guessing a password.
const TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Constant-time comparison of two token hashes. The lookup itself is an
// indexed equality match in Postgres — which is not constant time, and
// deliberately so: a timing side channel on a b-tree probe of a 256-bit
// random value is not a practical attack. This exists for the places that
// compare two hashes in application code.
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
