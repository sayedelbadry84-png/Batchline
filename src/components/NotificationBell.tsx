"use client";

import { useState } from "react";
import Link from "next/link";
import { markNotificationRead, markAllNotificationsRead } from "@/app/(app)/notifications/actions";

type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

// The sidebar's entry point into the general notification engine (see
// Notification's model comment in schema.prisma) — a simple open/close
// dropdown, no live push, matching the rest of this app's "refetch on
// navigation" pattern rather than a socket. notifications/unreadCount are
// computed server-side in (app)/layout.tsx and handed down as plain data,
// same reasoning as Sidebar's own allowedModules prop.
export function NotificationBell({
  notifications,
  unreadCount,
  labels,
}: {
  notifications: NotificationItem[];
  unreadCount: number;
  labels: { title: string; empty: string; markAllRead: string };
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-surface-alt hover:text-ink"
        aria-label={labels.title}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 shrink-0">
          <path d="M6 8a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.5 17a2.5 2.5 0 0 0 5 0" strokeLinecap="round" />
        </svg>
        {labels.title}
        {unreadCount > 0 && (
          <span className="ms-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-critical px-1 font-mono text-[0.6rem] text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="glass-surface border-glass-border absolute start-0 top-full z-50 mt-1 w-80 rounded-xl border p-2 shadow-lg">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-sm font-semibold">{labels.title}</span>
              {unreadCount > 0 && (
                <form action={markAllNotificationsRead}>
                  <button className="text-xs font-medium text-accent-strong hover:underline">{labels.markAllRead}</button>
                </form>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 && <p className="px-2 py-4 text-center text-sm text-ink-muted">{labels.empty}</p>}
              {notifications.map((n) => (
                <div key={n.id} className={`flex items-start gap-2 rounded-lg px-2 py-2 text-sm ${!n.readAt ? "bg-accent-soft/40" : ""}`}>
                  <div className="min-w-0 flex-1">
                    {n.link ? (
                      <Link href={n.link} className="font-medium hover:underline" onClick={() => setOpen(false)}>
                        {n.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{n.title}</span>
                    )}
                    {n.body && <p className="text-ink-muted text-xs">{n.body}</p>}
                    <p className="text-ink-faint mt-0.5 font-mono text-[0.65rem]" dir="ltr">{new Date(n.createdAt).toLocaleString()}</p>
                  </div>
                  {!n.readAt && (
                    <form action={markNotificationRead}>
                      <input type="hidden" name="id" value={n.id} />
                      <button className="shrink-0 text-xs text-accent-strong hover:underline" aria-label="mark read">✓</button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
