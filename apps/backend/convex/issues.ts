import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByWorkspace = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    return await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

export const getById = query({
  args: { id: v.id("issues") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("shaping"),
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    priority: v.number(),
    assigneeName: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    position: v.number(),
  },
  handler: async (ctx, args) => {
    // Auto-generate identifier: ORQ-N (workspace-scoped counter)
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const maxNum = existing.reduce((max, issue) => {
      const match = issue.identifier.match(/^ORQ-(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    const now = Date.now();
    return await ctx.db.insert("issues", {
      ...args,
      identifier: `ORQ-${maxNum + 1}`,
      assigneeAvatarUrl: undefined,
      labelIds: args.labelIds,
      linearId: undefined,
      linearIdentifier: undefined,
      linearUrl: undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("issues"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("todo"),
        v.literal("in_progress"),
        v.literal("in_review"),
        v.literal("done"),
      ),
    ),
    priority: v.optional(v.number()),
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.optional(v.array(v.id("issueLabels"))),
    position: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("issues"),
    status: v.union(
      v.literal("shaping"),
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
    position: v.number(),
  },
  handler: async (ctx, { id, status, position }) => {
    await ctx.db.patch(id, { status, position, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.id("issues") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const upsertFromLinear = mutation({
  args: {
    workspaceId: v.string(),
    linearId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.number(),
    assigneeName: v.optional(v.string()),
    assigneeAvatarUrl: v.optional(v.string()),
    labelIds: v.array(v.id("issueLabels")),
    linearIdentifier: v.string(),
    linearUrl: v.string(),
    mappedStatus: v.union(
      v.literal("shaping"),
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
    ),
  },
  handler: async (ctx, { mappedStatus, ...args }) => {
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_linearId", (q) => q.eq("linearId", args.linearId))
      .first();

    const now = Date.now();

    if (existing) {
      // Update non-Orchestra fields only. Status and position are user-owned.
      await ctx.db.patch(existing._id, {
        title: args.title,
        description: args.description,
        priority: args.priority,
        assigneeName: args.assigneeName,
        assigneeAvatarUrl: args.assigneeAvatarUrl,
        labelIds: args.labelIds,
        linearIdentifier: args.linearIdentifier,
        linearUrl: args.linearUrl,
        updatedAt: now,
      });
      return { id: existing._id, created: false };
    }

    // New issue — compute position (append to end of target column)
    const columnIssues = await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("status"), mappedStatus))
      .collect();
    const maxPosition = columnIssues.reduce((max, i) => Math.max(max, i.position), 0);

    // Generate identifier from linearIdentifier
    const id = await ctx.db.insert("issues", {
      ...args,
      identifier: args.linearIdentifier,
      status: mappedStatus,
      position: maxPosition + 1,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});
