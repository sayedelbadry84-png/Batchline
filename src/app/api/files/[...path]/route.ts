import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readFile } from "@/lib/blob";

// The only reader of the app's private Vercel Blob store (see
// src/lib/blob.ts) — any logged-in user can fetch a file here, same
// low-friction internal-tool posture as the rest of the app (nothing
// stored through this route needs finer-grained access control than "you
// have a Batchline account"). Unauthenticated requests get a flat 401
// rather than a redirect to /login, since this is hit from <img src>/
// fetch, not a page navigation.
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path } = await params;
  const pathname = path.join("/");
  const result = await readFile(pathname).catch(() => null);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(result.stream, {
    headers: { "Content-Type": result.blob.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" },
  });
}
