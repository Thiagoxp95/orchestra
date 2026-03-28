import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const listByWorkspace = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    return await ctx.db
      .query("issueLabels")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

export const create = mutation({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("issueLabels", args);
  },
});

export const findOrCreateByName = mutation({
  args: {
    workspaceId: v.string(),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, { workspaceId, name, color }) => {
    const existing = await ctx.db
      .query("issueLabels")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .filter((q) => q.eq(q.field("name"), name))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("issueLabels", { workspaceId, name, color });
  },
});
