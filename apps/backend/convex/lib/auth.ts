import type { QueryCtx, MutationCtx } from "../_generated/server";

export async function requireToken(ctx: QueryCtx | MutationCtx, token: string): Promise<void> {
  const row = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row) throw new Error("unauthorized");
}

export function requireDevice(secret: string): void {
  if (!process.env.DEVICE_SECRET || secret !== process.env.DEVICE_SECRET) {
    throw new Error("unauthorized");
  }
}

