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
  assert.ok(result.claimed >= 1);
  assert.ok(result.resolved >= 1);
  assert.ok(deletedPathnames.includes(url.replace("/api/files/", "")));

  const stillQueued = await prisma.pendingBlobDeletion.findUnique({ where: { id: queued.id } });
  assert.equal(stillQueued, null, "a resolved row must be removed, not left for another retry");
});

test("retryPendingBlobDeletions leaves a row queued and records the new error when the retry itself still fails", async () => {
  const url = `${TEST_URL_PREFIX}${Date.now()}-retry-fail.jpg`;
  await deleteFileDurable(url, "DELIVERY_PHOTO_COMPENSATION", alwaysFails);
  const queued = await prisma.pendingBlobDeletion.findFirstOrThrow({ where: { url } });

  const result = await retryPendingBlobDeletions(alwaysFails);
  assert.ok(result.claimed >= 1);

  const stillQueued = await prisma.pendingBlobDeletion.findUnique({ where: { id: queued.id } });
  assert.ok(stillQueued, "a retry that fails again must leave the row queued for the next sweep, not silently drop it");
  assert.equal(stillQueued!.attempts, 1);
  assert.ok(stillQueued!.lastError?.includes("simulated blob-storage delete failure"));
  assert.ok(stillQueued!.lastTriedAt);
  // PL-R10-P2-03: real backoff, not "retry again in the very next sweep
  // no matter what" — and nowhere near the dead-letter threshold yet.
  assert.ok(stillQueued!.nextAttemptAt.getTime() > queued.nextAttemptAt.getTime(), "a failed retry must push nextAttemptAt further into the future");
  assert.equal(stillQueued!.deadLetteredAt, null);
});

// PL-R12-P2-06, twelfth production-lifecycle review: the small test below
// proves the scheduling RULE, but the acceptance case was stated as 200
// poison rows and a 201st resolvable one at the real production claim
// size — the boundary where a full batch of failures could still occupy
// every slot. This is that literal case.
test("200 always-failing rows plus a 201st resolvable one at the real claim size: the resolvable row is still reached on the next sweep", async () => {
  const stamp = Date.now();
  const poisonPrefix = `${TEST_URL_PREFIX}${stamp}-bulk-poison-`;
  const resolvableUrl = `${TEST_URL_PREFIX}${stamp}-bulk-resolvable.jpg`;

  // Explicit nextAttemptAt so eligibility ordering is controlled, not
  // dependent on insertion timing: every poison row sorts strictly ahead
  // of the resolvable one, which is the worst case for starvation.
  const base = Date.now() - 60 * 60 * 1000;
  await prisma.pendingBlobDeletion.createMany({
    data: Array.from({ length: 200 }, (_, i) => ({
      url: `${poisonPrefix}${i}.jpg`,
      reason: "DELIVERY_PHOTO_COMPENSATION",
      nextAttemptAt: new Date(base + i),
    })),
  });
  await prisma.pendingBlobDeletion.create({
    data: { url: resolvableUrl, reason: "DELIVERY_PHOTO_COMPENSATION", nextAttemptAt: new Date(base + 1000) },
  });

  const deleted: string[] = [];
  const deleter = async (pathname: string) => {
    if (pathname.includes("bulk-poison")) throw new Error("permanently failing");
    deleted.push(pathname);
  };

  try {
    // The REAL production claim size — exactly the batch boundary where a
    // full set of failures could otherwise fill every slot forever.
    const first = await retryPendingBlobDeletions(deleter, 200);
    assert.equal(first.claimed, 200);
    assert.equal(first.resolved, 0);
    assert.equal(first.externalFailed, 200);
    assert.deepEqual(deleted, [], "the resolvable row is behind all 200 — it must not be reached on the first sweep");

    const second = await retryPendingBlobDeletions(deleter, 200);
    assert.equal(second.resolved, 1, "the 201st row must be reached on the very next sweep — 200 permanent failures must never occupy every claim slot");
    assert.deepEqual(deleted, [resolvableUrl.replace("/api/files/", "")]);
    assert.equal(await prisma.pendingBlobDeletion.count({ where: { url: resolvableUrl } }), 0);

    // The poison rows are all still queued, all backed off, none
    // dead-lettered after a single failure apiece.
    const poisonRows = await prisma.pendingBlobDeletion.findMany({ where: { url: { startsWith: poisonPrefix } } });
    assert.equal(poisonRows.length, 200);
    assert.ok(poisonRows.every((r) => r.attempts === 1 && r.deadLetteredAt === null));
  } finally {
    await prisma.pendingBlobDeletion.deleteMany({ where: { url: { startsWith: poisonPrefix } } });
    await prisma.pendingBlobDeletion.deleteMany({ where: { url: resolvableUrl } });
  }
});

// PL-R10-P2-03's own explicit required proof: "test that 200 poison rows
// do not starve a newer resolvable row." A small claim limit (1) proves
// the same general mechanism a real 200-row backlog relies on — the old
// blind `orderBy: createdAt` would re-select the identical oldest,
// permanently-failing row on every sweep, forever; real backoff moves a
// failing row's own nextAttemptAt into the future, so the very next
// sweep naturally reaches whatever resolvable row is queued behind it.
test("a permanently-failing deletion does not starve a newer resolvable one — a second sweep reaches the resolvable row instead of re-claiming the poisoned one", async () => {
  const poisonUrl = `${TEST_URL_PREFIX}${Date.now()}-poison.jpg`;
  const resolvableUrl = `${TEST_URL_PREFIX}${Date.now()}-resolvable.jpg`;
  // Staged in this order so the poison row's own nextAttemptAt sorts no
  // later than the resolvable one — same as a REAL older failing row.
  await deleteFileDurable(poisonUrl, "DELIVERY_PHOTO_COMPENSATION", alwaysFails);
  await deleteFileDurable(resolvableUrl, "DELIVERY_PHOTO_COMPENSATION", alwaysFails);
  const poison = await prisma.pendingBlobDeletion.findFirstOrThrow({ where: { url: poisonUrl } });

  // limit=1: the first sweep can only claim the oldest-by-nextAttemptAt
  // row — the poison one — and fails it again, pushing its nextAttemptAt
  // further into the future.
  const resolvedPathnames: string[] = [];
  const flakyDeleter = async (pathname: string) => {
    if (pathname === poisonUrl.replace("/api/files/", "")) throw new Error("still failing");
    resolvedPathnames.push(pathname);
  };

  const first = await retryPendingBlobDeletions(flakyDeleter, 1);
  assert.equal(first.claimed, 1);
  assert.equal(first.resolved, 0);
  const poisonAfterFirst = await prisma.pendingBlobDeletion.findUniqueOrThrow({ where: { id: poison.id } });
  assert.equal(poisonAfterFirst.attempts, 1);

  // A second sweep, same tiny limit — if the poison row still occupied
  // the only claim slot (the actual Round 10 bug), this would try to
  // delete the SAME poison url again instead of the resolvable one
  // queued right behind it.
  const second = await retryPendingBlobDeletions(flakyDeleter, 1);
  assert.equal(second.claimed, 1);
  assert.equal(second.resolved, 1, "the resolvable deletion must be reachable on the very next sweep — a permanently-failing row must never occupy every claim slot forever");
  assert.deepEqual(resolvedPathnames, [resolvableUrl.replace("/api/files/", "")]);

  assert.equal(await prisma.pendingBlobDeletion.findFirst({ where: { url: resolvableUrl } }), null, "the resolvable row must have actually been deleted and removed");
  const poisonStillThere = await prisma.pendingBlobDeletion.findUniqueOrThrow({ where: { id: poison.id } });
  assert.equal(poisonStillThere.attempts, 1, "the poison row must NOT have been reattempted in the second sweep — it's still correctly backed off");
});
