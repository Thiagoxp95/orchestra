import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  canAppendChunk,
  isChunkWithinLimit,
  isTerminalStatus,
  isValidAudioBase64,
  type DictationStatus,
} from "./dictationLogic";

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
    if (!isValidAudioBase64(pcm)) throw new Error("chunk not base64");
    const row = await byDictationId(ctx, dictationId);
    // Throw rather than return: the client retries on failure, and silently
    // swallowing a chunk that lost the race with startDictation is exactly how
    // the first word of an utterance used to disappear.
    if (!row) throw new Error("dictation not started");
    if (!canAppendChunk(row.status as DictationStatus)) return; // dropped after end
    // Idempotent on retry — a client resend must not double-feed the model.
    const dupe = await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId).eq("seq", seq))
      .unique();
    if (dupe) return;
    await ctx.db.insert("dictationChunks", { dictationId, seq, pcm, createdAt: Date.now() });
  },
});

export const endDictation = mutation({
  args: { token: v.string(), dictationId: v.string(), chunkCount: v.optional(v.number()) },
  handler: async (ctx, { token, dictationId, chunkCount }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && row.status === "recording") {
      await ctx.db.patch(row._id, {
        status: "ended",
        ...(chunkCount !== undefined ? { chunkCount } : {}),
        updatedAt: Date.now(),
      });
    }
  },
});

export const cancelDictation = mutation({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (row && !isTerminalStatus(row.status as DictationStatus)) {
      await ctx.db.patch(row._id, { status: "cancelled", updatedAt: Date.now() });
    }
  },
});

// The phone's only feedback channel. It subscribes to its own row and shows
// "Transcribing…" / the error / "No speech detected" from the terminal status,
// so a failed utterance is visible instead of the button silently doing nothing.
export const dictationStatus = query({
  args: { token: v.string(), dictationId: v.string() },
  handler: async (ctx, { token, dictationId }) => {
    await requireToken(ctx, token);
    const row = await byDictationId(ctx, dictationId);
    if (!row) return null;
    return {
      status: row.status as DictationStatus,
      finalText: row.finalText ?? "",
      error: row.error ?? "",
    };
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

export const finalizeDictation = mutation({
  args: { secret: v.string(), dictationId: v.string(), finalText: v.string() },
  handler: async (ctx, { secret, dictationId, finalText }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    // A user cancel mid-transcription wins: don't resurrect a cancelled row.
    if (row && !isTerminalStatus(row.status as DictationStatus)) {
      await ctx.db.patch(row._id, { status: "done", finalText, updatedAt: Date.now() });
    }
  },
});

// Terminal failure path (sidecar crash, transcription throw, finalize watchdog).
// Without this the phone waits forever on a row that will never reach 'done'.
export const failDictation = mutation({
  args: { secret: v.string(), dictationId: v.string(), error: v.string() },
  handler: async (ctx, { secret, dictationId, error }) => {
    requireDevice(secret);
    const row = await byDictationId(ctx, dictationId);
    if (row && !isTerminalStatus(row.status as DictationStatus)) {
      await ctx.db.patch(row._id, { status: "error", error, updatedAt: Date.now() });
    }
  },
});

// Deletes every chunk for the utterance. Previously bounded by the last seq the
// desktop had consumed, which orphaned any chunk that landed after the final
// drain — those rows then lived until the 5-minute prune.
export const deleteDictationChunks = mutation({
  args: { secret: v.string(), dictationId: v.string() },
  handler: async (ctx, { secret, dictationId }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("dictationChunks")
      .withIndex("by_dictation_seq", (q) => q.eq("dictationId", dictationId))
      .take(2000);
    for (const r of rows) await ctx.db.delete(r._id);
  },
});
