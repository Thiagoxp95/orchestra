import { action, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Pure credential check. Email case-insensitive; password exact. */
export function checkCredentials(
  email: string,
  password: string,
  envEmail: string | undefined,
  envPassword: string | undefined,
): boolean {
  if (!envEmail || !envPassword) return false;
  return email.trim().toLowerCase() === envEmail.trim().toLowerCase() && password === envPassword;
}

/** Web sign-in: validate against env, mint a token. Action (needs crypto). */
export const signIn = action({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    if (!checkCredentials(email, password, process.env.REMOTE_EMAIL, process.env.REMOTE_PASSWORD)) {
      return { error: "Invalid credentials" } as const;
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    await ctx.runMutation(internal.remoteAuth.storeSession, { token });
    return { token } as const;
  },
});

export const storeSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await ctx.db.insert("authSessions", { token, createdAt: Date.now() });
  },
});

/** Throws if the web token is not a known session. */
export async function requireToken(ctx: QueryCtx | MutationCtx, token: string): Promise<void> {
  const row = await ctx.db
    .query("authSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row) throw new Error("unauthorized");
}

/** Throws if the bridge device secret is wrong. */
export function requireDevice(secret: string): void {
  if (!process.env.DEVICE_SECRET || secret !== process.env.DEVICE_SECRET) {
    throw new Error("unauthorized");
  }
}
