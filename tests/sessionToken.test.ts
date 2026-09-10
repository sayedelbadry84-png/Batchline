// BL-CR-P1-05, external-review validation (2026-09-10): the properties
// that make a session cookie a credential rather than an identifier.
// Pure logic, no database — the DB half (a cookie no longer matching a
// row id, and an old-style cookie being refused) is covered by the
// integration suites, which now create fixture sessions through these
// same functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSessionToken, hashSessionToken, tokenHashesMatch } from "../src/lib/sessionToken";

test("a session token is 256 bits of CSPRNG output, base64url encoded", () => {
  const token = createSessionToken();
  // base64url of 32 bytes: 43 characters, no padding, URL/cookie safe.
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32, "OWASP asks for at least 128 bits for a custom session id; this is 256");
});

test("tokens do not repeat and carry no ordering an attacker could exploit", () => {
  const tokens = new Set(Array.from({ length: 500 }, () => createSessionToken()));
  assert.equal(tokens.size, 500, "every token must be independently random — the whole reason a cuid() was the wrong thing here");
  // A cuid encodes its creation time, so two tokens minted in sequence
  // share a long common prefix. These must not.
  const [a, b] = [createSessionToken(), createSessionToken()];
  let shared = 0;
  while (shared < a.length && a[shared] === b[shared]) shared++;
  assert.ok(shared < 8, "consecutively minted tokens must not share a timestamp-shaped prefix");
});

test("only the hash is storable, and it is a plain SHA-256 of the token", () => {
  const token = createSessionToken();
  const hash = hashSessionToken(token);
  assert.equal(hash, createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(token), "the stored value must not contain the credential it stands for");
  // Deterministic: the same cookie must resolve to the same row on every
  // request, which is the whole lookup path.
  assert.equal(hashSessionToken(token), hash);
  assert.notEqual(hashSessionToken(createSessionToken()), hash);
});

test("hash comparison is length-safe and exact", () => {
  const hash = hashSessionToken(createSessionToken());
  assert.equal(tokenHashesMatch(hash, hash), true);
  assert.equal(tokenHashesMatch(hash, hashSessionToken(createSessionToken())), false);
  // timingSafeEqual throws on unequal lengths — this must return false,
  // not blow up, for a truncated or padded value.
  assert.equal(tokenHashesMatch(hash, hash.slice(0, 10)), false);
  assert.equal(tokenHashesMatch("", hash), false);
});
