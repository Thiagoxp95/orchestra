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
    // Stamped when the board has a Linear view active, so a locally-created
    // issue stays visible instead of being filtered out by the view scope.
    linearViewIds: v.optional(v.array(v.string())),
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
    // The custom view this import came from, if any. Merged into the issue's
    // membership set — an issue can belong to several views at once.
    viewId: v.optional(v.string()),
  },
  handler: async (ctx, { mappedStatus, viewId, ...args }) => {
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_linearId", (q) => q.eq("linearId", args.linearId))
      .first();

    const now = Date.now();

    if (existing) {
      const viewIds = viewId
        ? Array.from(new Set([...(existing.linearViewIds ?? []), viewId]))
        : existing.linearViewIds;
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
        linearViewIds: viewIds,
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
      linearViewIds: viewId ? [viewId] : undefined,
      position: maxPosition + 1,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});

// Drop `viewId` from every workspace issue that the latest import of that view
// did NOT return, so the board's view scope reflects Linear rather than growing
// forever. Issues created in Orchestra while the view was active keep their
// stamp — they have no linearId, so they're never in `presentLinearIds`.
export const pruneViewMembership = mutation({
  args: {
    workspaceId: v.string(),
    viewId: v.string(),
    presentLinearIds: v.array(v.string()),
  },
  handler: async (ctx, { workspaceId, viewId, presentLinearIds }) => {
    const present = new Set(presentLinearIds);
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    let pruned = 0;
    for (const issue of issues) {
      if (!issue.linearViewIds?.includes(viewId)) continue;
      if (!issue.linearId || present.has(issue.linearId)) continue;
      const next = issue.linearViewIds.filter((id) => id !== viewId);
      await ctx.db.patch(issue._id, {
        linearViewIds: next.length ? next : undefined,
        updatedAt: Date.now(),
      });
      pruned++;
    }
    return { pruned };
  },
});
