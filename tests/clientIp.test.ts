// PR4-R4 / BL-CR-S2: which header may be believed. Pure logic — the whole
// point is that this decision is testable against crafted headers without
// a running server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientIp, UNKNOWN_CLIENT_IP } from "../src/lib/clientIp";

const headersFrom = (h: Record<string, string>) => (name: string) => h[name] ?? null;

test("off Vercel, no client-supplied header is believed", () => {
  const spoofed = headersFrom({
    "x-forwarded-for": "1.2.3.4",
    "x-real-ip": "1.2.3.4",
    "x-vercel-forwarded-for": "1.2.3.4",
  });
  assert.equal(resolveClientIp(spoofed, {}), UNKNOWN_CLIENT_IP, "without a known terminating proxy these are attacker input");
});

test("on Vercel, x-vercel-forwarded-for wins over a spoofed chain", () => {
  const h = headersFrom({
    // What an attacker sends. Vercel overwrites x-forwarded-for, but this
    // must not be consulted either way.
    "x-forwarded-for": "9.9.9.9, 8.8.8.8",
    "x-vercel-forwarded-for": "203.0.113.7",
    "x-real-ip": "198.51.100.2",
  });
  assert.equal(resolveClientIp(h, { VERCEL: "1" }), "203.0.113.7");
});

test("on Vercel, x-real-ip is the fallback and x-forwarded-for is never used", () => {
  assert.equal(resolveClientIp(headersFrom({ "x-real-ip": "198.51.100.2" }), { VERCEL: "1" }), "198.51.100.2");
  assert.equal(
    resolveClientIp(headersFrom({ "x-forwarded-for": "203.0.113.7" }), { VERCEL: "1" }),
    UNKNOWN_CLIENT_IP,
    "a client-supplied chain must never become the rate-limit key",
  );
});

test("only a plausible single IP literal is accepted as a key", () => {
  for (const bad of ["", "   ", "203.0.113.7, 8.8.8.8", "999.1.1.1", "not-an-ip", "'; DROP TABLE x;--", "a".repeat(60)]) {
    assert.equal(
      resolveClientIp(headersFrom({ "x-vercel-forwarded-for": bad }), { VERCEL: "1" }),
      UNKNOWN_CLIENT_IP,
      `${JSON.stringify(bad)} must not become a rate-limit key`,
    );
  }
  assert.equal(resolveClientIp(headersFrom({ "x-vercel-forwarded-for": "2001:db8::1" }), { VERCEL: "1" }), "2001:db8::1");
});

test("an attacker rotating the header cannot escape the bucket off Vercel", () => {
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) => resolveClientIp(headersFrom({ "x-forwarded-for": ip }), {})),
  );
  assert.deepEqual([...keys], [UNKNOWN_CLIENT_IP], "rotation must not produce a fresh throttle bucket per request");
});
