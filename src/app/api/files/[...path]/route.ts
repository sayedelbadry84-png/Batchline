import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readFile } from "@/lib/blob";
import { prisma } from "@/lib/prisma";
import { effectiveSiteId, tripPlantScopeWhere } from "@/lib/siteScope";
import { canAccessModule } from "@/lib/permissions";

// The only reader of the app's private Vercel Blob store (see
// src/lib/blob.ts). Delivery photos inherit their trip's site/driver
// authorization; an opaque filename is not an access-control boundary.
// Unauthenticated requests get a flat 401
// rather than a redirect to /login, since this is hit from <img src>/
// fetch, not a page navigation.
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path } = await params;
  if (path.some(part => !part || part === "." || part === ".." || /[\\/\u0000-\u001f]/.test(part))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const pathname = path.join("/");
  if (user.role !== "DRIVER" && !(await canAccessModule(user.role, "trips"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const trip = await prisma.trip.findFirst({
    where: {
      deliveryPhotoUrl: `/api/files/${pathname}`,
      ...tripPlantScopeWhere(effectiveSiteId(user)),
      ...(user.role === "DRIVER" ? { driverId: user.employeeId ?? "__unassigned__" } : {}),
    }, select: { id: true },
  });
  if (!trip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const result = await readFile(pathname).catch(() => null);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(result.stream, {
    headers: {
      "Content-Type": result.blob.contentType ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": /^(image\/(jpeg|png|gif|webp|avif))$/i.test(result.blob.contentType ?? "") ? "inline" : "attachment",
    },
  });
}
