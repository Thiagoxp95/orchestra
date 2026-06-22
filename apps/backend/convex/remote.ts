import { mutation, query, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
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

// ── State mirror (bridge writes, web reads) ───────────────────────────────

export const pushRemoteState = mutation({
  args: {
    secret: v.string(),
    workspaces: v.any(),
    sessions: v.any(),
    liveStatus: v.any(),
    activeWorkspaceId: v.union(v.string(), v.null()),
    activeSessionId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    requireDevice(args.secret);
    const existing = await ctx.db.query("remoteState").first();
    const patch = {
      workspaces: args.workspaces,
      sessions: args.sessions,
      liveStatus: args.liveStatus,
      activeWorkspaceId: args.activeWorkspaceId,
      activeSessionId: args.activeSessionId,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("remoteState", patch);
    }
  },
});

export const getRemoteState = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireToken(ctx, token);
    return await ctx.db.query("remoteState").first();
  },
});

// ── PTY output chunks (bridge writes, web reads) ──────────────────────────

export const appendChunk = mutation({
  args: { secret: v.string(), sessionId: v.string(), seq: v.number(), data: v.string() },
  handler: async (ctx, { secret, sessionId, seq, data }) => {
    requireDevice(secret);
    await ctx.db.insert("ptyChunks", { sessionId, seq, data, createdAt: Date.now() });
  },
});

export const clearChunks = mutation({
  args: { secret: v.string(), sessionId: v.string() },
  handler: async (ctx, { secret, sessionId }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("ptyChunks")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});

export const getChunks = query({
  args: { token: v.string(), sessionId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { token, sessionId, afterSeq }) => {
    await requireToken(ctx, token);
    return await ctx.db
      .query("ptyChunks")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId).gt("seq", afterSeq))
      .order("asc")
      .take(500);
  },
});

// ── Commands (web writes, bridge reads) ───────────────────────────────────

export const sendCommand = mutation({
  args: {
    token: v.string(),
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      // sessionId is unused; payload carries { workspaceId, actionId }.
      v.literal("runAction"),
      v.literal("createWorktree"),
      v.literal("spawnInTree"),
      v.literal("removeWorktree"),
    ),
    payload: v.any(),
  },
  handler: async (ctx, { token, sessionId, kind, payload }) => {
    await requireToken(ctx, token);
    await ctx.db.insert("ptyCommands", { sessionId, kind, payload, createdAt: Date.now() });
  },
});

export const pendingCommands = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret);
    return await ctx.db.query("ptyCommands").withIndex("by_created").order("asc").take(200);
  },
});

export const deleteCommand = mutation({
  args: { secret: v.string(), id: v.id("ptyCommands") },
  handler: async (ctx, { secret, id }) => {
    requireDevice(secret);
    await ctx.db.delete(id);
  },
});

// ── Prune old PTY data ───────────────────────────────────────────────────

export const pruneRemote = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const chunkCutoff = now - 2 * 60_000;
    const cmdCutoff = now - 60_000;
    const oldChunks = await ctx.db
      .query("ptyChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", chunkCutoff))
      .take(1000);
    for (const c of oldChunks) await ctx.db.delete(c._id);
    const oldCmds = await ctx.db
      .query("ptyCommands")
      .withIndex("by_created", (q) => q.lt("createdAt", cmdCutoff))
      .take(1000);
    for (const c of oldCmds) await ctx.db.delete(c._id);
  },
});
