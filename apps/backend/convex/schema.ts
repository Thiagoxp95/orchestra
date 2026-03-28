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
});
