import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { canAppendChunk, isChunkWithinLimit, type DictationStatus } from "./dictation-logic";

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

async function byDictationId(ctx: QueryCtx | MutationCtx, dictationId: string) {
  return ctx.db
    .query("dictation")
    .withIndex("by_dictationId", (q) => q.eq("dictationId", dictationId))
    .unique();
}

// ── Web → device (token-authed) ───────────────────────────────────────────

export const startDictation = mutation({
  args: { token: v.string(), dictationId: v.string(), sessionId: v.string() },
  handler: async (ctx, { token, dictationId, sessionId }) => {
    await requireToken(ctx, token);
    const existing = await byDictationId(ctx, dictationId);
    if (existing) return; // idempotent on retry
    const now = Date.now();
    await ctx.db.insert("dictation", {
      dictationId,
      sessionId,
      status: "recording",
      interimText: "",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const appendDictationChunk = mutation({
  args: { token: v.string(), dictationId: v.string(), seq: v.number(), pcm: v.string() },
  handler: async (ctx, { token, dictationId, seq, pcm }) => {
    await requireToken(ctx, token);
    if (!isChunkWithinLimit(pcm.length)) throw new Error("chunk too large");
    const row = await byDictationId(ctx, dictationId);
    if (!row || !canAppendChunk(row.status as DictationStatus)) return; // dropped after end
    await ctx.db.insert("dictationChunks", { dictationId, seq, pcm, createdAt: Date.now() });
  },
});

export const endDictation = mutation({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && row.status === "recording") {
      await ctx.db.patch(row._id, { status: "ended", updatedAt: Date.now() });
    }
  },
});

export const cancelDictation = mutation({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && row.status !== "done") {
      await ctx.db.patch(row._id, { status: "cancelled", updatedAt: Date.now() });
    }
  },
});

export const getDictation = query({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    return await byDictationId(ctx, dictationId);
  },
});

// ── Device → web (secret-authed) ──────────────────────────────────────────

export const pendingDictation = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret);
    const recording = await ctx.db
      .query("dictation")
      .withIndex("by_status", (q) => q.eq("status", "recording"))
      .collect();
    const ended = await ctx.db
      .query("dictation")
      .withIndex("by_status", (q) => q.eq("status", "ended"))
      .collect();
    return [...recording, ...ended].sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const getDictationChunks = query({
  args: { secret: v.string(), dictationId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { secret, dictationId, afterSeq }) => {
    requireDevice(secret);
    return await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId).gt("seq", afterSeq))
      .order("asc")
      .take(200);
  },
});

export const setDictationInterim = mutation({
  args: { secret: v.string(), dictationId: v.string(), interimText: v.string() },
  handler: async (ctx, { secret, dictationId, interimText }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    if (row) await ctx.db.patch(row._id, { interimText, updatedAt: Date.now() });
  },
});

export const finalizeDictation = mutation({
  args: { secret: v.string(), dictationId: v.string(), finalText: v.string() },
  handler: async (ctx, { secret, dictationId, finalText }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    if (row) await ctx.db.patch(row._id, { status: "done", finalText, updatedAt: Date.now() });
  },
});

export const deleteDictationChunks = mutation({
  args: { secret: v.string(), dictationId: v.string(), throughSeq: v.number() },
  handler: async (ctx, { secret, dictationId, throughSeq }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId).lte("seq", throughSeq))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});
