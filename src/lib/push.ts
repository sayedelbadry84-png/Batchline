import webpush from "web-push";
import { prisma } from "@/lib/prisma";

// Real OS-level push — the phone/desktop gets a notification even with
// the browser/app closed, unlike the in-app Notification bell alone.
// Self-contained: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are generated once
// with `npx web-push generate-vapid-keys` (see .env's own comment) and
// belong to this app, not any third-party push provider account — no
// external credentials to wait on here.
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@batchline.dev";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

export type PushPayload = { title: string; body?: string; link?: string };

/**
 * Sends a push message to every device this user has subscribed on. Never
 * throws — a push provider hiccup shouldn't fail the business action that
 * triggered it (see notify() in src/lib/notify.ts, the one caller). A
 * subscription the push service reports as gone (410/404 — uninstalled,
 * permission revoked, endpoint expired) is deleted on the spot rather than
 * kept around to fail the same way forever.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) return; // VAPID keys not configured — no-op, not an error

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
      } catch (e) {
        const statusCode = e instanceof webpush.WebPushError ? e.statusCode : null;
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
        // Any other failure (network hiccup, provider outage) is left
        // alone — the subscription may still be good next time.
      }
    }),
  );
}
