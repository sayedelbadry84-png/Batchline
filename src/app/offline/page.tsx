import Link from "next/link";
import { getDictionary } from "@/lib/i18n";

// BL-CR-P1-03, external-review validation (2026-09-10): the data-free
// shell the service worker serves when a navigation cannot reach the
// network.
//
// The point of this page is what it does NOT contain. The worker used to
// precache /operator, /driver and /pump-crew — authenticated, per-user
// server-rendered pages — into one origin-wide CacheStorage bucket, and
// then store every successful navigation response there too. On a shared
// plant tablet that meant the next person to pick it up (or the same
// device with no session at all) could be served the previous user's
// rendered operational data straight out of the cache, because signing
// out clears the server session and the cookie and nothing else.
//
// This page is reachable without a session, renders no record of any
// kind, and is the only navigation response the worker keeps. It is
// deliberately not a redirect: an offline device cannot follow one.
export default async function OfflinePage() {
  const { dict } = await getDictionary();
  const t = dict.offline;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 bg-bg px-6 py-10 text-center">
      <span className="font-display text-2xl font-semibold tracking-tight">{t.title}</span>
      <p className="text-sm text-ink-muted">{t.body}</p>
      {/* A queued reading lives in this browser's own storage (see
          src/lib/offlineQueue.ts) and is replayed automatically on
          reconnect — saying so is the difference between an operator
          trusting the queue and re-entering everything by hand. */}
      <p className="text-sm text-ink-muted">{t.queuedWorkSafe}</p>
      {/* Retrying is all this button can do: the network is what is
          missing, so the attempt either reaches the server now or lands
          right back on this same shell. */}
      <Link href="/" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-alt">
        {t.retry}
      </Link>
    </div>
  );
}
