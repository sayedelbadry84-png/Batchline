// Real PostgreSQL integration tests for the PendingBlobDeletion retry
// queue (src/lib/blob.ts) — PL-R9-P2-02, ninth production-lifecycle
// review. deleteFileDurable/retryPendingBlobDeletions take the actual
// deleting function as a parameter (BlobDeleter), defaulting to the real
// @vercel/blob del() in production — this suite supplies a fake one
// instead, so the retry-queue bookkeeping itself (create on failure,
// remove on a resolved retry, stay queued with a recorded error on a
// repeat failure) is provable without needing live blob-storage
// credentials this project's tests have no access to outside CI. See
// tests/offlineQueue.test.ts's own throwingStorage for the same
// injectable-failure pattern already established for StorageAdapter.
//
// Requires TEST_DATABASE_URL, same safety guard as batchCompletion.test.ts
// and productionLifecycle.test.ts — see those files' own comments.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

createRequire(import.meta.url)("./setup/stubServerOnly.cjs");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set to run these tests — see prisma/MIGRATIONS.md. Refusing to guess a database.");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to run destructive tests against what may be a real database.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { PrismaClient } = await import("@prisma/client");
const { deleteFileDurable, retryPendingBlobDeletions } = await import("../src/lib/blob");

const prisma = new PrismaClient();

const TEST_URL_PREFIX = "/api/files/delivery-photos/TEST-SUITE-BLOB-";

after(async () => {
  await prisma.pendingBlobDeletion.deleteMany({ where: { url: { startsWith: TEST_URL_PREFIX } } });
  const leftover = await prisma.pendingBlobDeletion.count({ where: { url: { startsWith: TEST_URL_PREFIX } } });
  assert.equal(leftover, 0, "blob.test.ts left PendingBlobDeletion residue behind");
  await prisma.$disconnect();
});

function alwaysFails(): Promise<void> {
  return Promise.reject(new Error("simulated blob-storage delete failure"));
}

test("a delete that succeeds never queues anything", async () => {
  const url = `${TEST_URL_PREFIX}${Date.now()}-ok.jpg`;
  let called: string | null = null;
  await deleteFileDurable(url, "DELIVERY_PHOTO_COMPENSATION", async (pathname) => {
    called = pathname;
  });
  assert.equal(called, url.replace("/api/files/", ""));

  const queued = await prisma.pendingBlobDeletion.findFirst({ where: { url } });
  assert.equal(queued, null, "a successful delete must never leave a retry row behind");
});

test("a delete that fails is queued for retry, and never throws out of the compensation path", async () => {
  const url = `${TEST_URL_PREFIX}${Date.now()}-fail.jpg`;
  // deleteFileDurable is called from inside compensation code (a refused
  // or thrown attachDeliveryPhotoForId) — it must never itself throw and
  // compound the failure it's cleaning up after.
  await assert.doesNotReject(() => deleteFileDurable(url, "DELIVERY_PHOTO_COMPENSATION", alwaysFails));

  const queued = await prisma.pendingBlobDeletion.findFirst({ where: { url } });
  assert.ok(queued, "a failed delete must be persisted for the cron sweep to retry");
  assert.equal(queued!.reason, "DELIVERY_PHOTO_COMPENSATION");
  assert.equal(queued!.attempts, 0, "queuing itself is not a retry attempt");
  assert.ok(queued!.lastError?.includes("simulated blob-storage delete failure"));
});

test("retryPendingBlobDeletions resolves a queued row once the delete actually succeeds, and removes it", async () => {
  const url = `${TEST_URL_PREFIX}${Date.now()}-retry-ok.jpg`;
  await deleteFileDurable(url, "DELIVERY_PHOTO_REPLACED", alwaysFails);
  const queued = await prisma.pendingBlobDeletion.findFirstOrThrow({ where: { url } });

  const deletedPathnames: string[] = [];
  const result = await retryPendingBlobDeletions(async (pathname) => {
    deletedPathnames.push(pathname);
  });
  assert.ok(result.attempted >= 1);
  assert.ok(result.succeeded >= 1);
  assert.ok(deletedPathnames.includes(url.replace("/api/files/", "")));

  const stillQueued = await prisma.pendingBlobDeletion.findUnique({ where: { id: queued.id } });
  assert.equal(stillQueued, null, "a resolved row must be removed, not left for another retry");
});

test("retryPendingBlobDeletions leaves a row queued and records the new error when the retry itself still fails", async () => {
  const url = `${TEST_URL_PREFIX}${Date.now()}-retry-fail.jpg`;
  await deleteFileDurable(url, "DELIVERY_PHOTO_COMPENSATION", alwaysFails);
  const queued = await prisma.pendingBlobDeletion.findFirstOrThrow({ where: { url } });

  const result = await retryPendingBlobDeletions(alwaysFails);
  assert.ok(result.attempted >= 1);

  const stillQueued = await prisma.pendingBlobDeletion.findUnique({ where: { id: queued.id } });
  assert.ok(stillQueued, "a retry that fails again must leave the row queued for the next sweep, not silently drop it");
  assert.equal(stillQueued!.attempts, 1);
  assert.ok(stillQueued!.lastError?.includes("simulated blob-storage delete failure"));
  assert.ok(stillQueued!.lastTriedAt);
});
