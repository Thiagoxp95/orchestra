"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";
import { buildPushPayload, isExpiredPushError } from "./push";

export const sendPush = internalAction({
  args: {
    title: v.string(),
    body: v.string(),
    sessionId: v.string(),
    requiresUserInput: v.boolean(),
  },
  handler: async (ctx, { title, body, sessionId, requiresUserInput }) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
      console.warn("[sendPush] VAPID env not configured — skipping");
      return;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const payload = buildPushPayload({ title, body, sessionId, requiresUserInput });
    const subs = await ctx.runQuery(internal.remote.allSubscriptions, {});

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
      } catch (err: any) {
        const status = err?.statusCode ?? 0;
        if (isExpiredPushError(status)) {
          await ctx.runMutation(internal.remote.pruneSubscription, { endpoint: sub.endpoint });
        } else {
          console.warn("[sendPush] send failed:", status, err?.message);
        }
      }
    }
  },
});
