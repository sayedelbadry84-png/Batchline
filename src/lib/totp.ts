import "server-only";
import { createHmac, randomBytes } from "crypto";

// RFC 6238 TOTP (RFC 4226 HOTP underneath), hand-rolled on Node's built-in
// crypto — no external auth/SMS service, works with any standard
// authenticator app (Google Authenticator, Authy, Microsoft Authenticator,
// 1Password, ...) since they all just implement this same RFC.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;
// Accept the code one step early or late — RFC 6238's standard allowance
// for clock drift between the server and the phone generating the code.
const WINDOW_STEPS = 1;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer per RFC 4226; JS numbers are
  // safe integers well past any realistic counter value here, so the
  // high 32 bits are always zero.
  counterBuffer.writeUInt32BE(0, 0);
  counterBuffer.writeUInt32BE(counter, 4);

  const hmac = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

// A fresh, never-yet-confirmed secret — see User.totpTempSecret in
// schema.prisma for why this isn't written straight to totpSecret.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// Standard otpauth:// URI most authenticator apps can also accept via a
// pasted link, alongside the plain manual-entry secret shown next to it.
export function totpUri(secret: string, accountLabel: string, issuer = "Batchline"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${CODE_DIGITS}&period=${STEP_SECONDS}`;
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const key = base32Decode(secret);
  const currentStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let delta = -WINDOW_STEPS; delta <= WINDOW_STEPS; delta++) {
    if (hotp(key, currentStep + delta) === trimmed) return true;
  }
  return false;
}
