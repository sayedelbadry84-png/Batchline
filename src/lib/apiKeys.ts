import "server-only";
import { randomBytes, createHash } from "crypto";

// The raw key is shown once at creation and never stored — only its hash
// (see ApiKey in schema.prisma). "bl_" prefix makes a leaked key
// recognizable as a Batchline credential in a log or scan.
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `bl_${randomBytes(24).toString("hex")}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 10) };
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
