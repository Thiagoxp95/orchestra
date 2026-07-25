import { mutation, query, internalMutation, internalQuery, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
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

/**
 * Should this push be dropped as superseded?
 *
 * The desktop stamps `incoming` when it BUILDS the payload. Its Convex socket
 * queues mutations while down and replays the whole backlog in order on
 * reconnect, so without this the mirror rewinds through every dead-window
 * snapshot before catching up — each replayed write stamping a fresh updatedAt
 * while carrying a stale payload. A mirror is latest-wins: only the newest
 * snapshot matters.
 *
 * `serverNow` is the referee for the clock-skew escape hatch. A legitimate stamp
 * is never in the future, so a stored value implausibly ahead of server time came
 * from a skewed client clock and must not be allowed to reject every future push
 * forever. A replay backlog can never trip that branch — its stamps are old.
 */
export function isSupersededPush(
  incoming: number | undefined,
  stored: number | undefined,
  serverNow: number,
): boolean {
  if (incoming === undefined || stored === undefined) return false;
  if (incoming >= stored) return false;
  return stored <= serverNow + 60_000;
}

export const pushRemoteState = mutation({
  args: {
    secret: v.string(),
    workspaces: v.any(),
    sessions: v.any(),
    liveStatus: v.any(),
    activeWorkspaceId: v.union(v.string(), v.null()),
    activeSessionId: v.union(v.string(), v.null()),
    geometryOwner: v.optional(v.union(v.literal("desktop"), v.literal("web"))),
    geometryEpoch: v.optional(v.number()),
    pushSeq: v.optional(v.number()),
    usage: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireDevice(args.secret);
    const existing = await ctx.db.query("remoteState").first();

    if (existing && isSupersededPush(args.pushSeq, existing.pushSeq, Date.now())) {
      return { accepted: false, stored: existing.pushSeq ?? null };
    }

    const patch = {
      workspaces: args.workspaces,
      sessions: args.sessions,
      liveStatus: args.liveStatus,
      activeWorkspaceId: args.activeWorkspaceId,
      activeSessionId: args.activeSessionId,
      geometryOwner: args.geometryOwner ?? "desktop",
      geometryEpoch: args.geometryEpoch ?? 0,
      updatedAt: Date.now(),
      // Leave a stored stamp untouched when an older desktop pushes without one,
      // so its writes can't strip the ordering token from the row.
      ...(args.pushSeq !== undefined ? { pushSeq: args.pushSeq } : {}),
      // Same reasoning for usage: an older desktop omits it entirely, and
      // patching `undefined` would delete a perfectly good mirrored value.
      ...(args.usage !== undefined ? { usage: args.usage } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("remoteState", patch);
    }
    return { accepted: true, stored: args.pushSeq ?? null };
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
  args: {
    secret: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    data: v.string(),
    seed: v.optional(v.boolean()),
  },
  handler: async (ctx, { secret, sessionId, seq, data, seed }) => {
    requireDevice(secret);
    await ctx.db.insert("ptyChunks", { sessionId, seq, data, seed, createdAt: Date.now() });
  },
});

// Highest seq currently stored for a session (or -1 if none). The bridge reads
// this on a cold-start attach to continue its per-session seq monotonically,
// so a desktop restart can't reset seq below a still-watching web client's
// afterSeq cursor (which would strand it on an empty getChunks forever).
export const headSeq = query({
  args: { secret: v.string(), sessionId: v.string() },
  handler: async (ctx, { secret, sessionId }) => {
    requireDevice(secret);
    const last = await ctx.db
      .query("ptyChunks")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    return last ? last.seq : -1;
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
      // A focused web/phone claims geometry ownership: payload { cols, rows } is
      // the phone's real viewport at its font. The bridge resizes EVERY open PTY
      // to it and re-seeds the attached session (see remote-bridge claimGeometry).
      v.literal("claimGeometry"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      // sessionId is unused; payload carries { workspaceId, actionId }.
      v.literal("runAction"),
      v.literal("createWorktree"),
      v.literal("spawnInTree"),
      v.literal("removeWorktree"),
      // payload: { storageId, mime } — image uploaded to Convex storage by the
      // web; the bridge downloads it and types its local path into the session.
      v.literal("sendImage"),
      // Linear ticket flow. generateTicketDraft payload { requestId }: kick off an
      // AI pass over the session's worktree. createLinearTicket payload
      // { requestId, fields }: create the finalized ticket in Linear + link the branch.
      v.literal("generateTicketDraft"),
      v.literal("createLinearTicket"),
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

// ── Remote images (web uploads, bridge downloads) ─────────────────────────

// Web asks for a short-lived URL, POSTs the image blob to it, and sends the
// resulting storageId through sendCommand('sendImage').
export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireToken(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

export const imageUrl = query({
  args: { secret: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { secret, storageId }) => {
    requireDevice(secret);
    return await ctx.storage.getUrl(storageId);
  },
});

// Bridge deletes the blob once it has the bytes on disk.
export const deleteImage = mutation({
  args: { secret: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { secret, storageId }) => {
    requireDevice(secret);
    await ctx.storage.delete(storageId);
  },
});

// ── Prune old PTY data ───────────────────────────────────────────────────

export const pruneRemote = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Keep a wider chunk window than strictly needed for a live viewer: a phone
    // that backgrounds (or a Mac that locks) for a couple of minutes must still
    // find the chunks between its stale afterSeq and the live tail on reconnect,
    // or it resumes with a hole in the stateful ANSI stream. The window only has
    // to outlast a realistic background gap — the wake/foreground re-seed repairs
    // anything longer.
    const chunkCutoff = now - 5 * 60_000;
    const cmdCutoff = now - 60_000;
    const oldChunks = await ctx.db
      .query("ptyChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", chunkCutoff))
      .take(3000);
    for (const c of oldChunks) await ctx.db.delete(c._id);
    const oldCmds = await ctx.db
      .query("ptyCommands")
      .withIndex("by_created", (q) => q.lt("createdAt", cmdCutoff))
      .take(1000);
    for (const c of oldCmds) await ctx.db.delete(c._id);
    // Dictation rows + chunks are short-lived; reap anything older than 5 min in
    // case a desktop disconnected mid-utterance and never consumed/finalized it.
    const dictCutoff = now - 5 * 60_000;
    const oldDictChunks = await ctx.db
      .query("dictationChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", dictCutoff))
      .take(3000);
    for (const c of oldDictChunks) await ctx.db.delete(c._id);
    const oldDict = await ctx.db
      .query("dictation")
      .withIndex("by_created", (q) => q.lt("createdAt", dictCutoff))
      .take(1000);
    for (const d of oldDict) await ctx.db.delete(d._id);
    // Ticket drafts are short-lived request/response rows; a 15-min window
    // comfortably outlasts a slow agent pass plus the user editing the draft.
    const draftCutoff = now - 15 * 60_000;
    const oldDrafts = await ctx.db
      .query("ticketDrafts")
      .withIndex("by_created", (q) => q.lt("createdAt", draftCutoff))
      .take(1000);
    for (const d of oldDrafts) await ctx.db.delete(d._id);
    // Orphaned remote-image blobs: the bridge deletes each one right after
    // downloading, so anything older than a few minutes means the command was
    // pruned unconsumed or the bridge died mid-download. 10 min comfortably
    // outlasts a slow upload + the 60s command window.
    const imageCutoff = now - 10 * 60_000;
    const oldFiles = await ctx.db.system
      .query("_storage")
      .filter((q) => q.lt(q.field("_creationTime"), imageCutoff))
      .take(100);
    for (const f of oldFiles) await ctx.storage.delete(f._id);
  },
});

// ── Web Push subscriptions ────────────────────────────────────────────────

export const subscribe = mutation({
  args: { token: v.string(), endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, { token, endpoint, p256dh, auth }) => {
    await requireToken(ctx, token);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { token, p256dh, auth });
    } else {
      await ctx.db.insert("pushSubscriptions", {
        token, endpoint, p256dh, auth, createdAt: Date.now(),
      });
    }
  },
});

export const unsubscribe = mutation({
  args: { token: v.string(), endpoint: v.string() },
  handler: async (ctx, { token, endpoint }) => {
    await requireToken(ctx, token);
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const pruneSubscription = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

// ── allSubscriptions (used by sendPush action) ────────────────────────────

export const allSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("pushSubscriptions").collect(),
});

// ── Notify (device → push fan-out) ───────────────────────────────────────

export const notify = mutation({
  args: {
    secret: v.string(),
    title: v.string(),
    body: v.string(),
    sessionId: v.string(),
    requiresUserInput: v.boolean(),
  },
  handler: async (ctx, { secret, title, body, sessionId, requiresUserInput }) => {
    requireDevice(secret);
    await ctx.scheduler.runAfter(0, internal.sendPush.sendPush, {
      title, body, sessionId, requiresUserInput,
    });
  },
});
