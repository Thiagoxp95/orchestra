import { action, internalMutation } from "./_generated/server";
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

