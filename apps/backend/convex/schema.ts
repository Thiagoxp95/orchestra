import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Maps a unique token to a local workspace action.
  // External services (Linear, GitHub, etc.) POST to /webhook/{token}.
  webhooks: defineTable({
    token: v.string(),
    workspaceId: v.string(),
    actionId: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    filter: v.optional(v.string()), // plain-English condition evaluated by LLM
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // Incoming webhook payloads awaiting processing by the desktop app.
  //
  //  Event lifecycle:
  //    pending ──▶ processing ──▶ completed
  //                    │              │
  //                    └──▶ failed    └──▶ expired (TTL)
  //
  webhookEvents: defineTable({
    webhookId: v.id("webhooks"),
    token: v.string(),
    workspaceId: v.string(), // denormalized from webhook
    actionId: v.string(), // denormalized from webhook
    payload: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("expired"),
      v.literal("filtered"), // LLM filter rejected this event
    ),
    filterResult: v.optional(v.string()), // LLM reasoning for filter decision
    filterPrompt: v.optional(v.string()), // plain-English condition at evaluation time
    createdAt: v.number(),
    processedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  issueLabels: defineTable({
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  }).index("by_workspace", ["workspaceId"]),

  issues: defineTable({
    workspaceId: v.string(),
    identifier: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("shaping"),
      v.literal("todo"),
      v.literal("up_next"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    priority: v.number(), // 0=none, 1=urgent, 2=high, 3=medium, 4=low
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    linearId: v.optional(v.string()),
    linearIdentifier: v.optional(v.string()),
    linearUrl: v.optional(v.string()),
    // Linear custom views this issue belongs to, as of the last import for each
    // view. The board filters by the active view id; pruneViewMembership drops
    // a view id once an issue falls out of that view.
    linearViewIds: v.optional(v.array(v.string())),
    position: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_linearId", ["linearId"]),

  // ── Orchestra Web remote client ───────────────────────────────────────

  // Web session tokens minted by signIn (single user, but allow multiple
  // browser sessions). Validated on every web query/mutation.
  authSessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // Singleton: sanitized mirror of the desktop's workspace/session state.
  remoteState: defineTable({
    workspaces: v.any(),       // sanitized Workspace[] (no secrets)
    sessions: v.any(),         // Record<sessionId, {label,processStatus,cwd,workspaceId,actionIcon?}>
    liveStatus: v.any(),       // Record<sessionId, {work:'idle'|'working', exited?:boolean, label?:string}>
    activeWorkspaceId: v.union(v.string(), v.null()),
    activeSessionId: v.union(v.string(), v.null()),
    // Geometry ownership: which client currently drives the shared PTY size.
    // 'desktop' (default) means the desktop's fit owns it and web scales to view;
    // 'web' means a focused web/phone claimed it, every PTY was resized to the
    // phone's viewport, and the DESKTOP scales to view. Optional for migration:
    // rows written before this field existed are treated as 'desktop'. The epoch
    // bumps on every claim so both ends detect a handoff even when the cols/rows
    // happen to be unchanged.
    geometryOwner: v.optional(v.union(v.literal("desktop"), v.literal("web"))),
    geometryEpoch: v.optional(v.number()),
    updatedAt: v.number(),
    // Desktop-stamped push ordering token (Date.now() at payload construction,
    // NOT at execution). The bridge's Convex socket queues mutations while it is
    // down and replays them IN ORDER on reconnect, so a backlog would otherwise
    // rewind the mirror through minutes of dead state — each replayed write
    // stamping a fresh updatedAt while carrying a stale payload. pushRemoteState
    // drops any push older than the stored one. Optional: rows written before
    // this field existed (and pushes from an older desktop) have none.
    pushSeq: v.optional(v.number()),
    // Compact provider rate-limit usage (Claude / Codex session + weekly +
    // scoped windows), mirrored from the desktop's usage-manager so the phone
    // shows the same "how close am I to the limit" numbers the desktop footer
    // badge does. Percentages only — no token counts, cost, or account data.
    // Optional: rows written before this field existed (and pushes from an older
    // desktop, which leave it untouched) have none.
    usage: v.optional(v.any()),
  }),

  // Batched terminal output for the attached session (append-only).
  ptyChunks: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    data: v.string(),          // plain decoded terminal text
    // True for the full-screen snapshot that opens each (re)attach. The web
    // resets its xterm before applying a seed chunk, so a re-seed (new viewer,
    // wake re-seed, respawn) cleanly repaints instead of appending onto stale
    // content. seq stays monotonic across re-seeds (see remote-bridge ChunkSeq)
    // so an already-watching client's afterSeq cursor never strands above it.
    seed: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_created", ["createdAt"]),

  // Structured agent-conversation mirror (chat view). Append-mostly: the desktop
  // parses transcript JSONL into ChatMessages and upserts them here; the web reads
  // them as a cursor stream. seq is monotonic per session and NEVER resets (same
  // invariant as ptyChunks — see remote-bridge ChunkSeq); uid dedupes re-pushes
  // (resume replays, tailer restarts).
  agentMessages: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    uid: v.string(),
    role: v.string(),
    blocks: v.any(),
    ts: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_session_uid", ["sessionId", "uid"])
    .index("by_created", ["createdAt"]),

  // Commands from web → bridge.
  ptyCommands: defineTable({
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("claimGeometry"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      v.literal("runAction"),
      v.literal("createWorktree"),
      v.literal("spawnInTree"),
      v.literal("removeWorktree"),
      v.literal("sendImage"),
      // Chat-composer send with attachments: the bridge downloads every image,
      // then types "<path> <path> <text>" as ONE bracketed paste and submits it
      // (sendImage only types a bare path into the prompt, no submit).
      v.literal("sendChatMessage"),
      // Linear ticket flow (see ticketDrafts): kick off AI generation for the
      // session's worktree, and create the finalized ticket in Linear.
      v.literal("generateTicketDraft"),
      v.literal("createLinearTicket"),
      // Resume flow (see agentSessions): read the recent Claude/Codex sessions
      // off the desktop's disk, and respawn one of them in its own directory.
      v.literal("listAgentSessions"),
      v.literal("resumeAgentSession"),
    ),
    payload: v.any(),          // write:{data}; resize/claimGeometry:{cols,rows}; runAction:{workspaceId,actionId}; createWorktree:{workspaceId,branch,selectedActionIds,spinUp}; spawnInTree:{workspaceId,treeIndex,agent?,actionId?}; removeWorktree:{workspaceId,treeIndex}; sendImage:{storageId,mime}; sendChatMessage:{text,images:[{storageId,mime}]}; generateTicketDraft:{requestId}; createLinearTicket:{requestId,fields}; listAgentSessions:{requestId}; resumeAgentSession:{agent,sessionId,cwd}; others:{}
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

  // ── Remote voice dictation ────────────────────────────────────────────

  // One row per dictation utterance. Web writes start/end/cancel; the desktop
  // orchestrator writes finalText once the utterance is transcribed (and types
  // that text into the PTY). There is no live preview.
  //
  // The row doubles as the phone's only feedback channel: it polls its own row
  // for the terminal status, so "no speech detected" and sidecar failures
  // surface on-screen instead of the button just going quiet.
  dictation: defineTable({
    dictationId: v.string(),   // client-generated uuid
    sessionId: v.string(),     // target agent session
    status: v.union(
      v.literal("recording"),
      v.literal("ended"),
      v.literal("done"),
      v.literal("cancelled"),
      v.literal("error"),
    ),
    interimText: v.optional(v.string()), // vestigial: retained for old rows
    finalText: v.optional(v.string()),
    // Total chunks the phone uploaded, written with the 'ended' patch. The
    // desktop waits until it has consumed exactly this many before asking the
    // sidecar to transcribe — polling "no new rows this tick" alone finalizes
    // early on a slow link and truncates the tail of the utterance.
    chunkCount: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dictationId", ["dictationId"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  // Audio chunks for an in-flight dictation. Web appends base64 PCM16; the
  // desktop reads them in seq order, feeds the sidecar, then deletes them.
  dictationChunks: defineTable({
    dictationId: v.string(),
    seq: v.number(),
    pcm: v.string(),           // base64 PCM16 mono 16kHz
    createdAt: v.number(),
  })
    .index("by_dictation_seq", ["dictationId", "seq"])
    .index("by_created", ["createdAt"]),

  // ── Linear ticket drafts ──────────────────────────────────────────────

  // One row per "generate a Linear ticket for this worktree" request. Web
  // inserts it (status 'generating') and polls by requestId; the desktop
  // orchestrator runs a headless Claude agent over the worktree, writes the
  // generated draft + the team's projects/labels/viewer (status 'ready'), then
  // — once the user confirms — creates the issue and renames the branch
  // (status 'creating' → 'created'). Short-lived; reaped by pruneRemote.
  ticketDrafts: defineTable({
    requestId: v.string(),     // client-generated uuid
    sessionId: v.string(),     // session whose worktree we're describing
    status: v.union(
      v.literal("generating"),
      v.literal("ready"),
      v.literal("creating"),
      v.literal("created"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    draft: v.optional(v.any()),    // editable draft: {title, description, labelNames, projectName, priority}
    viewer: v.optional(v.any()),   // {id, displayName} — default assignee
    projects: v.optional(v.any()), // LinearProject[] for the selector
    labels: v.optional(v.any()),   // {id,name,color}[] for the selector
    result: v.optional(v.any()),   // {identifier, url} once created
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_created", ["createdAt"]),

  // ── Recent agent sessions (resume from the phone) ─────────────────────

  // One row per "list the recent Claude/Codex sessions" request. The web inserts
  // it (status 'loading') alongside a `listAgentSessions` command and subscribes
  // by requestId; the desktop reads its transcript directories and patches the
  // row with a capped, sanitized list. Kept out of the always-on state mirror
  // because it is hundreds of entries that only matter while the sheet is open.
  // Short-lived; reaped by pruneRemote.
  agentSessions: defineTable({
    requestId: v.string(),     // client-generated uuid
    status: v.union(v.literal("loading"), v.literal("ready"), v.literal("error")),
    // RemoteAgentSession[]: {agent, sessionId, cwd, cwdExists, gitBranch,
    // updatedAt, title, summary, summaryIsUser} — see remote-bridge-agent-sessions.
    sessions: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_created", ["createdAt"]),

  // Web Push subscriptions for the installed PWA (iOS/Android/desktop browser).
  // Single user, so every row belongs to the signed-in user.
  pushSubscriptions: defineTable({
    token: v.string(),     // owning web auth session token
    endpoint: v.string(),  // push service endpoint (unique key)
    p256dh: v.string(),    // subscription.keys.p256dh
    auth: v.string(),      // subscription.keys.auth
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_endpoint", ["endpoint"]),
});
