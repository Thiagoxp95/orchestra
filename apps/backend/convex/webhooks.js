import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
// ── Internal queries (called from httpAction only) ───────────────────
/** Look up a webhook by its URL token. Internal — only http.ts calls this. */
export const getByToken = internalQuery({
    args: { token: v.string() },
    handler: async (ctx, { token }) => {
        return await ctx.db
            .query("webhooks")
            .withIndex("by_token", (q) => q.eq("token", token))
            .first();
    },
});
export const getPendingEvents = query({
    args: {},
    handler: async (ctx) => {
        return await ctx.db
            .query("webhookEvents")
            .withIndex("by_status", (q) => q.eq("status", "pending"))
            .take(50);
    },
});
export const getRecentEventNotifications = query({
    args: { since: v.number() },
    handler: async (ctx, { since }) => {
        return await ctx.db
            .query("webhookEvents")
            .withIndex("by_created", (q) => q.gt("createdAt", since))
            .order("desc")
            .take(20);
    },
});
// ── Mutations ────────────────────────────────────────────────────────
export const create = mutation({
    args: {
        token: v.string(),
        workspaceId: v.string(),
        actionId: v.string(),
        name: v.string(),
        filter: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("webhooks")
            .withIndex("by_token", (q) => q.eq("token", args.token))
            .first();
        if (existing)
            throw new Error("Token already exists");
        return await ctx.db.insert("webhooks", {
            ...args,
            enabled: true,
            createdAt: Date.now(),
        });
    },
});
export const updateFilter = mutation({
    args: {
        token: v.string(),
        filter: v.optional(v.string()),
    },
    handler: async (ctx, { token, filter }) => {
        const webhook = await ctx.db
            .query("webhooks")
            .withIndex("by_token", (q) => q.eq("token", token))
            .first();
        if (!webhook)
            throw new Error("Webhook not found");
        await ctx.db.patch(webhook._id, { filter: filter || undefined });
    },
});
export const remove = mutation({
    args: { token: v.string() },
    handler: async (ctx, { token }) => {
        const webhook = await ctx.db
            .query("webhooks")
            .withIndex("by_token", (q) => q.eq("token", token))
            .first();
        if (!webhook)
            return;
        // Delete associated events
        const events = await ctx.db
            .query("webhookEvents")
            .filter((q) => q.eq(q.field("token"), token))
            .collect();
        for (const event of events) {
            await ctx.db.delete(event._id);
        }
        await ctx.db.delete(webhook._id);
    },
});
/** Store an incoming webhook payload. Internal — only http.ts calls this. */
export const createEvent = internalMutation({
    args: {
        webhookId: v.id("webhooks"),
        token: v.string(),
        workspaceId: v.string(),
        actionId: v.string(),
        payload: v.any(),
        filterResult: v.optional(v.string()),
        filterPrompt: v.optional(v.string()),
        filtered: v.optional(v.boolean()),
    },
    handler: async (ctx, { filtered, ...args }) => {
        return await ctx.db.insert("webhookEvents", {
            ...args,
            status: filtered ? "filtered" : "pending",
            createdAt: Date.now(),
        });
    },
});
/** Atomically claim a pending event. Returns event data if claimed, null if already taken. */
export const claimEvent = mutation({
    args: { eventId: v.id("webhookEvents") },
    handler: async (ctx, { eventId }) => {
        const event = await ctx.db.get(eventId);
        if (!event || event.status !== "pending")
            return null;
        await ctx.db.patch(eventId, { status: "processing" });
        return event;
    },
});
export const completeEvent = mutation({
    args: {
        eventId: v.id("webhookEvents"),
        status: v.union(v.literal("completed"), v.literal("failed"), v.literal("expired")),
    },
    handler: async (ctx, { eventId, status }) => {
        const event = await ctx.db.get(eventId);
        if (!event)
            return;
        await ctx.db.patch(eventId, { status, processedAt: Date.now() });
    },
});
// ── Internal (cron) ──────────────────────────────────────────────────
/** Delete webhook events older than 7 days. */
export const cleanupOldEvents = internalMutation({
    args: {},
    handler: async (ctx) => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const oldEvents = await ctx.db
            .query("webhookEvents")
            .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
            .collect();
        for (const event of oldEvents) {
            await ctx.db.delete(event._id);
        }
        return { deleted: oldEvents.length };
    },
});
