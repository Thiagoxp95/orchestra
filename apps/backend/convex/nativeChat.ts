import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { requireDevice, requireToken } from './lib/auth'
import { parseNativeChatCommand } from '../../desktop/src/shared/native-chat-validation'

export const getSession = query({
  args: { token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    await requireToken(ctx, args.token)
    const state = await ctx.db.query('nativeChatSessions').withIndex('by_session', q => q.eq('sessionId', args.sessionId)).unique()
    if (!state) return null
    const pending = await ctx.db.query('nativeChatCommands').withIndex('by_session_status', q => q.eq('sessionId', args.sessionId).eq('status', 'pending')).take(100)
    return { ...state.snapshot, pendingCommands: pending.filter(row => !['interrupt', 'respond'].includes(row.command.kind)).length }
  },
})
export const messages = query({
  args: { token: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => { await requireToken(ctx, args.token); return await ctx.db.query('agentMessages').withIndex('by_session_seq', q => q.eq('sessionId', args.sessionId)).order('asc').take(400) },
})
export const publish = mutation({
  args: { secret: v.string(), snapshot: v.any() },
  handler: async (ctx, { secret, snapshot }) => {
    requireDevice(secret)
    if (typeof snapshot?.sessionId !== 'string' || typeof snapshot.revision !== 'number') throw new Error('Invalid native chat snapshot')
    const existing = await ctx.db.query('nativeChatSessions').withIndex('by_session', q => q.eq('sessionId', snapshot.sessionId)).unique()
    if (existing && existing.revision > snapshot.revision) return
    const data = { sessionId: snapshot.sessionId, snapshot, revision: snapshot.revision, updatedAt: Date.now() }
    if (existing) await ctx.db.patch(existing._id, data)
    else await ctx.db.insert('nativeChatSessions', data)
  },
})
export const enqueue = mutation({
  args: { token: v.string(), sessionId: v.string(), command: v.any(), uploads: v.optional(v.array(v.object({ storageId: v.id('_storage'), mime: v.string() }))) },
  handler: async (ctx, args) => {
    await requireToken(ctx, args.token)
    // Remote clients cannot name arbitrary files on the host. Uploads are resolved there.
    if (args.command?.kind === 'send' && args.command.images?.length) throw new Error('Use uploaded images for remote chat')
    if ((args.uploads?.length ?? 0) > 4) throw new Error('At most four images are allowed')
    // Permit an image-only send before the host has resolved its file paths.
    const toParse = args.command?.kind === 'send' && args.uploads?.length ? { ...args.command, images: args.uploads.map(i => i.storageId) } : args.command
    const command = parseNativeChatCommand(toParse)
    if (command.kind === 'send') command.images = []
    if (command.kind === 'interrupt') {
      const pending = await ctx.db.query('nativeChatCommands').withIndex('by_session_status', q => q.eq('sessionId', args.sessionId).eq('status', 'pending')).collect()
      for (const row of pending) if (row.status === 'pending' && ['send', 'configure', 'compact', 'start'].includes(row.command?.kind)) await ctx.db.patch(row._id, { status: 'failed', error: 'Cancelled by Stop', command: { kind: row.command.kind }, uploads: undefined, updatedAt: Date.now() })
    }
    return await ctx.db.insert('nativeChatCommands', { sessionId: args.sessionId, command, ...(args.uploads ? { uploads: args.uploads } : {}), status: 'pending', priority: command.kind === 'interrupt' ? 0 : 1, updatedAt: Date.now() })
  },
})
export const pending = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireDevice(secret)
    const [stops, commands] = await Promise.all([
      ctx.db.query('nativeChatCommands').withIndex('by_status', q => q.eq('status', 'pending').eq('priority', 0)).collect(),
      ctx.db.query('nativeChatCommands').withIndex('by_status', q => q.eq('status', 'pending').eq('priority', 1)).take(100),
    ])
    return [...stops, ...commands]
  },
})
export const receipt = query({
  args: { token: v.string(), commandId: v.id('nativeChatCommands') },
  handler: async (ctx, { token, commandId }) => {
    await requireToken(ctx, token)
    const row = await ctx.db.get(commandId)
    if (!row) return { status: 'failed' as const, error: 'Command receipt expired; inspect the conversation before sending again' }
    return row.status === 'pending' ? null : { status: row.status, ...(row.error ? { error: row.error } : {}) }
  },
})
export const finish = mutation({
  args: { secret: v.string(), commandId: v.id('nativeChatCommands'), error: v.optional(v.string()) },
  handler: async (ctx, { secret, commandId, error }) => {
    requireDevice(secret)
    const row = await ctx.db.get(commandId)
    if (!row || row.status !== 'pending') return
    await ctx.db.patch(commandId, { command: { kind: row.command.kind }, uploads: undefined, status: error ? 'failed' : 'accepted', ...(error ? { error } : {}), updatedAt: Date.now() })
  },
})
