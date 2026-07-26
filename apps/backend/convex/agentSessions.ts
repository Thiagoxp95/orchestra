// Recent Claude / Codex sessions, on demand, for the web's "Resume a session"
// sheet.
//
// The list lives on the desktop's disk (~/.claude/projects, ~/.codex/sessions)
// and is hundreds of entries, so it is NOT part of the always-on state mirror:
// the web inserts a request row, sends a `listAgentSessions` command, and the
// desktop fills the same row in. Short-lived — reaped by pruneRemote.

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
    .query("agentSessions")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .unique();
}

// ── Web → device (token-authed) ───────────────────────────────────────────

export const requestAgentSessions = mutation({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, { token, requestId }) => {
    await requireToken(ctx, token);
    const existing = await byRequestId(ctx, requestId);
    if (existing) return; // idempotent on retry
    const now = Date.now();
    await ctx.db.insert("agentSessions", {
      requestId,
      status: "loading",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getAgentSessions = query({
  args: { token: v.string(), requestId: v.string() },
  handler: async (ctx, { token, requestId }) => {
    await requireToken(ctx, token);
    return await byRequestId(ctx, requestId);
  },
});

// ── Device → web (secret-authed) ──────────────────────────────────────────

export const fulfillAgentSessions = mutation({
  args: { secret: v.string(), requestId: v.string(), sessions: v.any() },
  handler: async (ctx, { secret, requestId, sessions }) => {
    requireDevice(secret);
    const row = await byRequestId(ctx, requestId);
    if (!row) return;
    await ctx.db.patch(row._id, { status: "ready", sessions, updatedAt: Date.now() });
  },
});

export const failAgentSessions = mutation({
  args: { secret: v.string(), requestId: v.string(), error: v.string() },
  handler: async (ctx, { secret, requestId, error }) => {
    requireDevice(secret);
    const row = await byRequestId(ctx, requestId);
    if (!row) return;
    await ctx.db.patch(row._id, { status: "error", error, updatedAt: Date.now() });
  },
});
