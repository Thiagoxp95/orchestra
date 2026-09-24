// src/main/local-server/api.ts
//
// Every function the phone can call, registered against the sync hub. This is
// the direct replacement for the Convex function surface — same names, so the
// web call sites read the same, but each one is now a local function call.
//
// Reads are subscriptions: the hub re-runs them and pushes when the underlying
// state is invalidated. Writes are one-shot and answered with their result.

import { isChunkWithinLimit, isValidAudioBase64 } from '../../shared/dictation'
import { getDurableStore } from './durable-store'
import type { SyncHub } from './sync-hub'
import * as state from './runtime-state'
import { isAllowedUploadMime, MAX_UPLOAD_BYTES } from './uploads'
import { savePushSubscription, removePushSubscription } from './push'
import { resolveUpload } from './uploads'
import { executeNativeChat, nativeChatMessages, nativeChatSnapshot, setNativeChatView } from '../native-chat/service'

/** A command the phone sent, as handed to the desktop. */
export interface RemoteCommand {
  sessionId: string
  kind: string
  payload: any
  /** When this server received it. Orders a chat send against a later Stop. */
  receivedAt: number
}

/** Applies a web command against the desktop. Wired by remote-bridge. */
export type CommandHandler = (command: RemoteCommand) => Promise<void>

export interface CommandHandlerOptions {
  /**
   * Commands that must not wait behind the queue — a chat Stop has to reach the
   * agent while the send it is stopping is still being typed. The old Convex
   * path delivered these at subscription time, ahead of the drain; here they
   * simply skip the chain.
   */
  immediate?: (command: RemoteCommand) => boolean
}

let applyCommand: CommandHandler | null = null
let isImmediate: ((command: RemoteCommand) => boolean) | null = null

export function setCommandHandler(handler: CommandHandler | null, options: CommandHandlerOptions = {}): void {
  applyCommand = handler
  isImmediate = handler ? options.immediate ?? null : null
}

/**
 * Commands apply one at a time. The phone can fire several in a burst (a
 * resize plus a keystroke plus a spawn) and they must reach the PTY in the
 * order they were sent, which a bare `await` per socket message would not
 * guarantee. A failure is reported to its caller and never wedges the chain.
 */
let commandChain: Promise<void> = Promise.resolve()

function enqueueCommand(command: RemoteCommand): Promise<void> {
  const run = commandChain.then(async () => {
    if (!applyCommand) throw new Error('Desktop is not ready for commands yet')
    await applyCommand(command)
  })
  commandChain = run.catch(() => {})
  return run
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

export function registerApi(hub: SyncHub): void {
  const store = getDurableStore()

  // ── Desktop state mirror ───────────────────────────────────────────────

  hub.query('remote.getRemoteState', () => state.getRemoteState())

  hub.call('remote.sendCommand', async (args) => {
    const kind = str(args, 'kind')
    if (!applyCommand) throw new Error('Desktop is not ready for commands yet')
    const command: RemoteCommand = {
      // Workspace-level commands (spawnInTree, createWorktree) carry no session.
      sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
      kind,
      payload: args.payload ?? {},
      receivedAt: Date.now(),
    }
    if (isImmediate?.(command)) await applyCommand(command)
    else await enqueueCommand(command)
    return null
  })

  // ── Native chat ────────────────────────────────────────────────────────
  // The chat half of the Chat ⇄ Terminal toggle. Commands bypass the PTY queue:
  // they drive the provider SDK, not keystrokes.

  hub.query('nativeChat.getSession', (args) => nativeChatSnapshot(str(args, 'sessionId')))

  hub.query('nativeChat.messages', (args) => nativeChatMessages(str(args, 'sessionId')))

  hub.call('nativeChat.command', (args) => {
    const uploads = Array.isArray(args.uploads) ? args.uploads : []
    if (uploads.length > 4) throw new Error('At most four images are allowed')
    const images = uploads.map((upload) => {
      const path = resolveUpload(str(upload as Record<string, unknown>, 'storageId'))
      if (!path) throw new Error('Image upload expired. Attach it again')
      return path
    })
    const command = args.command as Record<string, unknown> | undefined
    return executeNativeChat(
      str(args, 'sessionId'),
      images.length && command?.kind === 'send' ? { ...command, images } : command,
    )
  })

  hub.call('nativeChat.setView', (args) => setNativeChatView(str(args, 'sessionId'), args.view))

  // ── Image uploads ──────────────────────────────────────────────────────

  // Kept as a "get a URL, then POST to it" handshake so the phone's paste path
  // is unchanged; the URL is now simply this server's own upload route.
  hub.call('remote.generateUploadUrl', () => '/api/upload')

  // ── Push notifications ─────────────────────────────────────────────────

  hub.call('remote.subscribe', (args) => {
    savePushSubscription({
      endpoint: str(args, 'endpoint'),
      p256dh: str(args, 'p256dh'),
      auth: str(args, 'auth'),
    })
    return null
  })

  hub.call('remote.unsubscribe', (args) => {
    removePushSubscription(str(args, 'endpoint'))
    return null
  })

  // ── Dictation ──────────────────────────────────────────────────────────

  hub.query('remoteDictation.dictationStatus', (args) => {
    const row = state.getDictation(str(args, 'dictationId'))
    if (!row) return null
    return { status: row.status, finalText: row.finalText ?? '', error: row.error ?? '' }
  })

  hub.call('remoteDictation.startDictation', (args) => {
    state.startDictation(str(args, 'dictationId'), str(args, 'sessionId'))
    return null
  })

  hub.call('remoteDictation.appendDictationChunk', (args) => {
    const pcm = str(args, 'pcm')
    if (!isChunkWithinLimit(pcm.length)) throw new Error('chunk too large')
    if (!isValidAudioBase64(pcm)) throw new Error('chunk not base64')
    const seq = args.seq
    if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new Error('seq must be an integer')
    state.appendDictationChunk(str(args, 'dictationId'), seq, pcm)
    return null
  })

  hub.call('remoteDictation.endDictation', (args) => {
    const count = typeof args.chunkCount === 'number' ? args.chunkCount : undefined
    state.endDictation(str(args, 'dictationId'), count)
    return null
  })

  hub.call('remoteDictation.cancelDictation', (args) => {
    state.cancelDictation(str(args, 'dictationId'))
    return null
  })

  // ── Ticket drafts ──────────────────────────────────────────────────────

  hub.query('ticketDrafts.getTicketDraft', (args) => state.getTicketDraft(str(args, 'requestId')))

  hub.call('ticketDrafts.startTicketDraft', (args) => {
    state.startTicketDraft(str(args, 'requestId'), str(args, 'sessionId'))
    return null
  })

  hub.call('ticketDrafts.cancelTicketDraft', (args) => {
    state.cancelTicketDraft(str(args, 'requestId'))
    return null
  })

  // ── Agent session listings ─────────────────────────────────────────────

  hub.query('agentSessions.getAgentSessions', (args) => state.getAgentSessions(str(args, 'requestId')))

  hub.call('agentSessions.requestAgentSessions', (args) => {
    state.requestAgentSessions(str(args, 'requestId'))
    return null
  })

  // ── Issue board ────────────────────────────────────────────────────────
  // Read by the desktop renderer over IPC; exposed here too so the board can
  // be opened on the phone without a second data path.

  hub.query('issues.listByWorkspace', (args) =>
    store.issues.filter((row) => row.workspaceId === str(args, 'workspaceId')),
  )

  hub.query('issueLabels.listByWorkspace', (args) =>
    store.issueLabels.filter((row) => row.workspaceId === str(args, 'workspaceId')),
  )
}

export { MAX_UPLOAD_BYTES, isAllowedUploadMime }
