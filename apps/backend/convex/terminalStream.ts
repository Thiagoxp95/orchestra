import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireDevice, requireToken } from './lib/auth';

/** Relay-only authorization. Terminal bytes never enter Convex. */
export const authorize = query({
  args: { secret: v.string(), token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    requireDevice(args.secret);
    await requireToken(ctx, args.token);
    const state = await ctx.db.query('remoteState').first();
    const sessions = state?.sessions;
    if (!sessions || typeof sessions !== 'object' || !Object.prototype.hasOwnProperty.call(sessions, args.sessionId)) {
      throw new Error('Session unavailable');
    }
    return { authorized: true };
  },
});
