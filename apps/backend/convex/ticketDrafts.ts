import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";

async function requireToken(ctx: QueryCtx | MutationCtx, token: string): Promise<void> {
  const row = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row) throw new Error("unauthorized");
}

function requireDevice(secret: string): void {
  if (!process.env.DEVICE_SECRET || secret !== process.env.DEVICE_SECRET) {
    throw new Error("unauthorized");
  }
}

async function byRequestId(ctx: QueryCtx | MutationCtx, requestId: string) {
  return ctx.db
    .query("ticketDrafts")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .unique();
}

// ── Web → device (token-authed) ───────────────────────────────────────────

export const startTicketDraft = mutation({
  args: { token: v.string(), requestId: v.string(), sessionId: v.string() },
  handler: async (ctx, { token, requestId, sessionId }) => {
    await requireToken(ctx, token);
    const existing = await byRequestId(ctx, requestId);
    if (existing) return; // idempotent on retry
    const now = Date.now();
    await ctx.db.insert("ticketDrafts", {
      requestId,
      sessionId,
      status: "generating",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getTicketDraft = query({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, { token, requestId }) => {
    await requireToken(ctx, token);
    return await byRequestId(ctx, requestId);
  },
});

export const cancelTicketDraft = mutation({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, { token, requestId }) => {
    await requireToken(ctx, token);
    const row = await byRequestId(ctx, requestId);
    // Terminal states stay put; anything mid-flight becomes cancelled so the
    // desktop drops it if it hasn't finished yet.
    if (row && row.status !== "created" && row.status !== "error") {
      await ctx.db.patch(row._id, { status: "cancelled", updatedAt: Date.now() });
    }
  },
});

// ── Device → web (secret-authed) ──────────────────────────────────────────

// Fallback poll (the primary trigger is a ptyCommand). Cheap: drafts are
// short-lived so the by_created scan stays tiny.
export const pendingTicketDrafts = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret);
    return await ctx.db
      .query("ticketDrafts")
      .withIndex("by_created")
      .filter((q) => q.eq(q.field("status"), "generating"))
      .collect();
  },
});

// The desktop finished analysing the worktree: store the generated draft and the
// team option lists the web's editor needs. No-op if the request was cancelled.
export const finalizeTicketDraft = mutation({
  args: {
    secret: v.string(),
    requestId: v.string(),
    draft: v.any(),
    viewer: v.any(),
    projects: v.any(),
    labels: v.any(),
  },
  handler: async (ctx, { secret, requestId, draft, viewer, projects, labels }) => {
    requireDevice(secret);
    const row = await byRequestId(ctx, requestId);
    if (row && row.status === "generating") {
      await ctx.db.patch(row._id, {
        status: "ready",
        draft,
        viewer,
        projects,
        labels,
        updatedAt: Date.now(),
      });
    }
  },
});

export const setTicketDraftStatus = mutation({
  args: {
    secret: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal("creating"),
      v.literal("created"),
      v.literal("error"),
    ),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { secret, requestId, status, result, error }) => {
    requireDevice(secret);
    const row = await byRequestId(ctx, requestId);
    if (!row) return;
    await ctx.db.patch(row._id, {
      status,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      updatedAt: Date.now(),
    });
  },
});
