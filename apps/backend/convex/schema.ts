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
});
