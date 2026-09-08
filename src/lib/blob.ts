import { put, del, get } from "@vercel/blob";
import { prisma } from "@/lib/prisma";

// The one place in the app that talks to object storage — Vercel Blob,
// since the app is already deployed on Vercel and this needs no separate
// cloud account. Replaces the earlier data-URL-in-a-Postgres-column
// stopgap (see the old comments on Trip.deliveryPhotoUrl) now that real
// photo volume matters. BLOB_READ_WRITE_TOKEN is read from the
// environment automatically by @vercel/blob — set by Vercel itself in
// production, and must be copied into .env.local for local dev (see the
// Storage tab in the Vercel dashboard).
//
// The store is PRIVATE (the project's own choice) — nothing in it is
// directly fetchable by a URL alone. uploadFile returns an app-relative
// URL under /api/files/... instead of the blob's own URL; that route
// (src/app/api/files/[...path]/route.ts) is what actually calls get()
// server-side and streams the bytes back, gated on the app's own session
// auth same as every other page. Callers never see a raw Blob pathname or
// talk to @vercel/blob directly — this file and that one route are the
// only two.
export async function uploadFile(pathname: string, file: File): Promise<string> {
  const blob = await put(pathname, file, { access: "private", addRandomSuffix: true, contentType: file.type });
  return `/api/files/${blob.pathname}`;
}

export async function deleteFile(appUrl: string): Promise<void> {
  const pathname = appUrl.replace(/^\/api\/files\//, "");
  await del(pathname).catch(() => {});
}

// Injectable, same reasoning as offlineQueue.ts's own StorageAdapter —
// the real @vercel/blob del() needs live storage credentials this
// project's tests have no access to outside CI, so deleteFileDurable/
// retryPendingBlobDeletions below take the deleting function as a
// parameter (defaulting to the real one) purely so their own retry-queue
// bookkeeping — create on failure, remove on a resolved retry, keep
// queued with a recorded error on a repeat failure — is provable in
// plain node:test against a real Postgres database, without needing a
// real blob store at all.
export type BlobDeleter = (pathname: string) => Promise<void>;
const defaultDeleter: BlobDeleter = (pathname) => del(pathname);

// PL-R9-P2-02, ninth production-lifecycle review: deleteFile above
// silently discards a failed delete — fine for the many callers that
// have no real recovery option anyway, but wrong for a COMPENSATING
// delete (an upload that already succeeded, then had to be undone) where
// silently discarding the failure just leaves an orphaned blob nothing
// ever cleans up. This still never throws (compensation code must not
// itself fail the request it's cleaning up after) — a failed delete is
// instead persisted to PendingBlobDeletion so the existing daily cron
// sweep (api/cron/cleanup) can keep retrying it until it actually
// succeeds. Even the persistence write can fail (a genuine DB outage at
// exactly the wrong moment) — there is no further fallback for that at
// this layer, so it's logged for a real operator to notice.
export async function deleteFileDurable(appUrl: string, reason: string, deleteFn: BlobDeleter = defaultDeleter): Promise<void> {
  const pathname = appUrl.replace(/^\/api\/files\//, "");
  try {
    await deleteFn(pathname);
  } catch (error) {
    try {
      await prisma.pendingBlobDeletion.create({ data: { url: appUrl, reason, lastError: String(error) } });
    } catch (persistError) {
      console.error(`[blob] failed to delete AND failed to record for retry: ${appUrl} (${reason})`, error, persistError);
    }
  }
}

// The api/cron/cleanup sweep's own half of PendingBlobDeletion — kept
// here rather than importing @vercel/blob's del() directly into the
// route, matching this file's own role as the one place that talks to
// object storage. Each row is retried once per sweep; a delete that
// succeeds removes the row, one that fails again just records the new
// error and is picked up by tomorrow's run — retried indefinitely rather
// than capped, since an orphaned blob costs storage, not correctness,
// and there is no safe point at which "give up forever" is the right
// call for it.
export async function retryPendingBlobDeletions(deleteFn: BlobDeleter = defaultDeleter): Promise<{ attempted: number; succeeded: number }> {
  const rows = await prisma.pendingBlobDeletion.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
  let succeeded = 0;
  for (const row of rows) {
    const pathname = row.url.replace(/^\/api\/files\//, "");
    try {
      await deleteFn(pathname);
      await prisma.pendingBlobDeletion.delete({ where: { id: row.id } }).catch(() => {});
      succeeded++;
    } catch (error) {
      await prisma.pendingBlobDeletion.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastError: String(error), lastTriedAt: new Date() } }).catch(() => {});
    }
  }
  return { attempted: rows.length, succeeded };
}

// Used only by the /api/files route — reads the same private blob back so
// it can stream the bytes to whoever's authenticated.
export async function readFile(pathname: string) {
  return get(pathname, { access: "private" });
}
