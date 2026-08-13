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

/**
 * Cheap structural-equality check for the fields that dominate remoteState's
 * document size (workspaces/sessions/liveStatus/usage). JSON.stringify is
 * good enough here — these are already the exact plain-object payloads about
 * to be written, so a byte-for-byte comparison is exactly what we want, and
 * the values are small enough (bridge-side sanitized, session-count bounded)
 * that stringifying twice per push is negligible next to a full doc rewrite.
 */
function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    slashCommands: v.optional(v.any()),
    updateStatus: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireDevice(args.secret);
    const existing = await ctx.db.query("remoteState").first();

    if (existing && isSupersededPush(args.pushSeq, existing.pushSeq, Date.now())) {
      return { accepted: false, stored: existing.pushSeq ?? null };
    }

    const geometryOwner = args.geometryOwner ?? "desktop";
    const geometryEpoch = args.geometryEpoch ?? 0;

    // The bridge pushes on a 10s heartbeat plus every focus/wake/status tap —
    // most of those fire with byte-identical state (nothing changed since the
    // last push). Writing the full workspaces/sessions/liveStatus/usage blob
    // on every one of those no-op ticks was the single largest DB-bandwidth
    // line item in the project. Only rewrite the heavy fields that actually
    // changed; `updatedAt` (the liveness signal bridge-liveness.ts polls) and
    // `pushSeq` still advance on every accepted push either way, so a
    // desktop that's simply idle is still reported online in realtime — this
    // only skips re-persisting data nothing has touched.
    const changed = {
      workspaces: !existing || !sameJSON(args.workspaces, existing.workspaces),
      sessions: !existing || !sameJSON(args.sessions, existing.sessions),
      liveStatus: !existing || !sameJSON(args.liveStatus, existing.liveStatus),
      activeWorkspaceId: !existing || args.activeWorkspaceId !== existing.activeWorkspaceId,
      activeSessionId: !existing || args.activeSessionId !== existing.activeSessionId,
      geometryOwner: !existing || geometryOwner !== existing.geometryOwner,
      geometryEpoch: !existing || geometryEpoch !== existing.geometryEpoch,
      usage:
        args.usage !== undefined && (!existing || !sameJSON(args.usage, existing.usage)),
      slashCommands:
        args.slashCommands !== undefined &&
        (!existing || !sameJSON(args.slashCommands, existing.slashCommands)),
      updateStatus:
        args.updateStatus !== undefined &&
        (!existing || !sameJSON(args.updateStatus, existing.updateStatus)),
    };

    // Typed so the compiler can verify `updatedAt` (a required column) is
    // always present on the object we hand to insert/patch, even though most
    // of these fields are only conditionally included.
    type RemoteStatePatch = {
      updatedAt: number;
      pushSeq?: number;
      workspaces?: unknown;
      sessions?: unknown;
      liveStatus?: unknown;
      activeWorkspaceId?: string | null;
      activeSessionId?: string | null;
      geometryOwner?: "desktop" | "web";
      geometryEpoch?: number;
      usage?: unknown;
      slashCommands?: unknown;
      updateStatus?: unknown;
    };

    const patch: RemoteStatePatch = {
      updatedAt: Date.now(),
      // Leave a stored stamp untouched when an older desktop pushes without one,
      // so its writes can't strip the ordering token from the row.
      ...(args.pushSeq !== undefined ? { pushSeq: args.pushSeq } : {}),
    };
    if (changed.workspaces) patch.workspaces = args.workspaces;
    if (changed.sessions) patch.sessions = args.sessions;
    if (changed.liveStatus) patch.liveStatus = args.liveStatus;
    if (changed.activeWorkspaceId) patch.activeWorkspaceId = args.activeWorkspaceId;
    if (changed.activeSessionId) patch.activeSessionId = args.activeSessionId;
    if (changed.geometryOwner) patch.geometryOwner = geometryOwner;
    if (changed.geometryEpoch) patch.geometryEpoch = geometryEpoch;
    // Same reasoning as pushSeq: an older desktop omits usage entirely, and
    // patching `undefined` would delete a perfectly good mirrored value.
    if (changed.usage) patch.usage = args.usage;
    if (changed.slashCommands) patch.slashCommands = args.slashCommands;
    // Same "older desktop omits it entirely" reasoning as usage/slashCommands:
    // never patch `undefined` over a value a newer desktop already mirrored.
    if (changed.updateStatus) patch.updateStatus = args.updateStatus;

    // Verify in Convex logs (on a live idle heartbeat) whether the diff above
    // is actually skipping fields — round-tripping a doc through Convex can
    // reorder JSON.stringify's key order, which would make sameJSON() see a
    // "change" on every push and silently zero out the bandwidth savings.
    console.log(
      "pushRemoteState: changed fields",
      Object.keys(changed).filter((key) => changed[key as keyof typeof changed]),
    );

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      // First-ever row: every field is "changed" by definition, so seed it
      // with the full payload regardless of the diff above.
      await ctx.db.insert("remoteState", {
        workspaces: args.workspaces,
        sessions: args.sessions,
        liveStatus: args.liveStatus,
        activeWorkspaceId: args.activeWorkspaceId,
        activeSessionId: args.activeSessionId,
        geometryOwner,
        geometryEpoch,
        ...(args.usage !== undefined ? { usage: args.usage } : {}),
        ...(args.slashCommands !== undefined ? { slashCommands: args.slashCommands } : {}),
        ...(args.updateStatus !== undefined ? { updateStatus: args.updateStatus } : {}),
        ...patch,
      });
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

// ── Structured chat mirror (bridge writes, web reads) ────────────────────

// Per-session row cap for agentMessages. The chat view only ever needs a
// scrollback window, not the full transcript — the terminal (and the desktop)
// remain the archive. 400 messages comfortably covers what anyone reads on a
// phone while keeping clearMessages safe to run as a single mutation.
export const AGENT_MESSAGE_CAP = 400;

/**
 * Which rows must go to enforce the per-session cap?
 *
 * Pure so the deletion decision is testable without a Convex runtime. Takes the
 * session's rows sorted ascending by seq and returns the prefix to delete:
 * lowest-seq first, because seq is the append order and the chat view reads the
 * tail — evicting from the head is the only order that never removes something
 * a live subscriber is about to render. Anything at or under the cap returns
 * empty, so the common no-overflow call is free.
 */
export function messageOverflow<Row>(
  rowsAscBySeq: readonly Row[],
  cap: number = AGENT_MESSAGE_CAP,
): Row[] {
  if (rowsAscBySeq.length <= cap) return [];
  return rowsAscBySeq.slice(0, rowsAscBySeq.length - cap);
}

/**
 * Clamp a client-supplied page size to something the server is willing to
 * serve. The web passes whatever its "load earlier" logic wants, but a query
 * must never `take()` a non-positive or unbounded count — a NaN or Infinity
 * from a buggy client degrades to a full page rather than an error, because a
 * backfill that returns something beats one that throws.
 */
export function clampPageLimit(limit: number, max = 100): number {
  if (!Number.isFinite(limit)) return max;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

// Upsert a batch of parsed transcript messages (callers send ≤ 40 per call).
// Keyed by uid, not seq: the desktop tailer re-reads transcript tails on
// restart and resume-swap, so the same record legitimately arrives more than
// once — possibly with a fresher parse. An existing row keeps its stored seq
// (its position in the stream is already fixed for every subscribed cursor)
// and only the content is refreshed; a new row lands at the tailer's seq.
export const appendMessages = mutation({
  args: {
    secret: v.string(),
    sessionId: v.string(),
    messages: v.array(
      v.object({
        uid: v.string(),
        seq: v.number(),
        role: v.string(),
        blocks: v.any(),
        ts: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { secret, sessionId, messages }) => {
    requireDevice(secret);
    const now = Date.now();
    for (const m of messages) {
      const existing = await ctx.db
        .query("agentMessages")
        .withIndex("by_session_uid", (q) => q.eq("sessionId", sessionId).eq("uid", m.uid))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          role: m.role,
          blocks: m.blocks,
          // Patching `ts: undefined` would delete a stored timestamp, and a
          // re-push that lost its ts (partial parse) shouldn't strip the one a
          // complete parse already recorded.
          ...(m.ts !== undefined ? { ts: m.ts } : {}),
        });
      } else {
        await ctx.db.insert("agentMessages", {
          sessionId,
          seq: m.seq,
          uid: m.uid,
          role: m.role,
          blocks: m.blocks,
          ts: m.ts,
          createdAt: now,
        });
      }
    }
    // Enforce the cap after the batch lands. Convex has no cheap count, but a
    // session is bounded at cap + one batch (~440 tiny rows), so collecting the
    // whole session to decide the overflow is fine inside a single mutation.
    const rows = await ctx.db
      .query("agentMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .collect();
    for (const r of messageOverflow(rows)) await ctx.db.delete(r._id);
  },
});

// Highest message seq stored for a session (or -1 if none). Same job as
// headSeq does for ptyChunks: the desktop tailer primes its per-session seq
// from this on cold start so a restart can never re-issue seqs below a
// still-watching web client's afterSeq cursor (which would strand it on an
// empty getMessages forever — the monotonic-seq invariant).
export const messagesHeadSeq = query({
  args: { secret: v.string(), sessionId: v.string() },
  handler: async (ctx, { secret, sessionId }) => {
    requireDevice(secret);
    const last = await ctx.db
      .query("agentMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    return last ? last.seq : -1;
  },
});

// Drop a session's entire conversation (session left the tracked set). The
// per-session cap bounds this at AGENT_MESSAGE_CAP rows, so collect + delete
// in one mutation is safe.
export const clearMessages = mutation({
  args: { secret: v.string(), sessionId: v.string() },
  handler: async (ctx, { secret, sessionId }) => {
    requireDevice(secret);
    const rows = await ctx.db
      .query("agentMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});

// The live tail: everything after the client's cursor, ascending. Message
// cadence is seconds (not the PTY's dozens of chunks per second), so a single
// afterSeq cursor is enough — the dual-cursor resubscribe dance getChunks
// needs does not apply here.
export const getMessages = query({
  args: { token: v.string(), sessionId: v.string(), afterSeq: v.number() },
  handler: async (ctx, { token, sessionId, afterSeq }) => {
    await requireToken(ctx, token);
    return await ctx.db
      .query("agentMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId).gt("seq", afterSeq))
      .order("asc")
      .take(100);
  },
});

// One-shot backfill page: the newest rows below a cursor, descending (the
// client reverses). Serves both the initial "last N messages" load
// (beforeSeq = MAX_SAFE_INTEGER) and the "load earlier" pill.
export const getMessagesBefore = query({
  args: { token: v.string(), sessionId: v.string(), beforeSeq: v.number(), limit: v.number() },
  handler: async (ctx, { token, sessionId, beforeSeq, limit }) => {
    await requireToken(ctx, token);
    return await ctx.db
      .query("agentMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId).lt("seq", beforeSeq))
      .order("desc")
      .take(clampPageLimit(limit));
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
      // payload: { text, images: [{ storageId, mime }] } — chat-composer send
      // with attachments: the bridge downloads the blobs and submits
      // "<path> <path> <text>" as one paste (unlike sendImage, which only
      // types a bare path and leaves the user composing).
      v.literal("sendChatMessage"),
      // Linear ticket flow. generateTicketDraft payload { requestId }: kick off an
      // AI pass over the session's worktree. createLinearTicket payload
      // { requestId, fields }: create the finalized ticket in Linear + link the branch.
      v.literal("generateTicketDraft"),
      v.literal("createLinearTicket"),
      // Resume flow. listAgentSessions payload { requestId }: read the recent
      // Claude/Codex transcripts off disk into the agentSessions row the web is
      // watching. resumeAgentSession payload { agent, sessionId, cwd }: respawn
      // that conversation in the tree that owns its directory.
      v.literal("listAgentSessions"),
      v.literal("resumeAgentSession"),
      // App-wide restart into a pending update. sessionId is unused (pass "");
      // payload is empty. The desktop is the authority on whether there is
      // anything to install — it reports back through remoteState.updateStatus
      // rather than answering this mutation, exactly like every other command.
      // Safe to send twice: the desktop latches the first accepted restart.
      v.literal("restartToUpdate"),
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
    // Idempotent: the bridge retries acks whose first attempt failed, and a
    // retry can race the row already being gone. A throw here reads as an ack
    // failure and keeps the retry loop alive forever.
    if (await ctx.db.get(id)) await ctx.db.delete(id);
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
    // Recent-agent-session listings: request/response rows that only matter
    // while the resume sheet is open, and each carries a few hundred entries.
    const listingCutoff = now - 15 * 60_000;
    const oldListings = await ctx.db
      .query("agentSessions")
      .withIndex("by_created", (q) => q.lt("createdAt", listingCutoff))
      .take(1000);
    for (const l of oldListings) await ctx.db.delete(l._id);
    // Agent chat messages are tiny and capped per session, so the TTL is a
    // safety net for dead sessions, not a live window — a phone opening hours
    // later must still find the conversation. 7 days comfortably outlasts any
    // realistic gap while keeping abandoned sessions from accreting forever.
    const messageCutoff = now - 7 * 24 * 60 * 60_000;
    const oldMessages = await ctx.db
      .query("agentMessages")
      .withIndex("by_created", (q) => q.lt("createdAt", messageCutoff))
      .take(2000);
    for (const m of oldMessages) await ctx.db.delete(m._id);
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
