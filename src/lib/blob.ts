import { put, del, get } from "@vercel/blob";

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

// Used only by the /api/files route — reads the same private blob back so
// it can stream the bytes to whoever's authenticated.
export async function readFile(pathname: string) {
  return get(pathname, { access: "private" });
}
