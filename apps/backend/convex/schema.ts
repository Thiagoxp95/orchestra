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
    updatedAt: v.number(),
  }),

  // Batched terminal output for the attached session (append-only).
  ptyChunks: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    data: v.string(),          // plain decoded terminal text
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_created", ["createdAt"]),

  // Commands from web → bridge.
  ptyCommands: defineTable({
    sessionId: v.string(),
    kind: v.union(
      v.literal("write"),
      v.literal("resize"),
      v.literal("kill"),
      v.literal("attach"),
      v.literal("detach"),
      v.literal("runAction"),
      v.literal("createWorktree"),
      v.literal("spawnInTree"),
      v.literal("removeWorktree"),
    ),
    payload: v.any(),          // write:{data}; resize:{cols,rows}; runAction:{workspaceId,actionId}; createWorktree:{workspaceId,branch,selectedActionIds,spinUp}; spawnInTree:{workspaceId,treeIndex,agent?,actionId?}; removeWorktree:{workspaceId,treeIndex}; others:{}
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

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
