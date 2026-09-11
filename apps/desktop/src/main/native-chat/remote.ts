import type { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { agentChatLog, type StoredChatMessage } from '../agent-chat-log'
import { saveRemoteImage } from '../remote-bridge-image'
import { nativeChatManager, nativeChatSnapshot, prepareNativeChatSend } from './service'
import type { NativeChatCommand, NativeChatSnapshot } from '../../shared/native-chat'
type RemoteCommand = { _id: string; _creationTime: number; sessionId: string; command: NativeChatCommand; uploads?: { storageId: string; mime: string }[] }
let current: ConvexClient | null = null
let unsubscribe: (() => void) | undefined
let commands: RemoteCommand[] = []
const running = new Set<string>()
const cutoffs = new Map<string, number>()
const states = new Map<string, NativeChatSnapshot>()
const revisions = new Map<string, number>()
const messages = new Map<string, Map<string, StoredChatMessage>>()
let flushing = false
let flushAgain = false
let scheduleTimer: ReturnType<typeof setTimeout> | undefined
let activeSecret = ''
let installedListener = false

export function nativeChatRemoteTick(client: ConvexClient, secret: string): void {
  activeSecret = secret
  if (!installedListener) {
    installedListener = true
    agentChatLog.subscribe(event => {
      if (event.kind !== 'append' || !nativeChatSnapshot(event.sessionId)) return
      const pending = messages.get(event.sessionId) ?? new Map<string, StoredChatMessage>()
      for (const row of event.messages) pending.set(row.uid, row)
      while (pending.size > 400) pending.delete(pending.keys().next().value!)
      messages.set(event.sessionId, pending)
      scheduleNativeChatPublish()
    })
  }
  if (current !== client) {
    unsubscribe?.()
    current = client
    revisions.clear()
    for (const state of nativeChatManager().all()) messages.set(state.sessionId, new Map(agentChatLog.since(state.sessionId, -1).map(row => [row.uid, row])))
    unsubscribe = client.onUpdate(anyApi.nativeChat.pending, { secret }, rows => {
      commands = rows as RemoteCommand[]
      observe(client, secret)
    }, error => console.error('[native-chat] command subscription failed', error))
  }
  observe(client, secret)
  scheduleNativeChatPublish()
}
function observe(client: ConvexClient, secret: string): void {
  for (const row of commands) {
    if (running.has(row._id)) continue
    const stop = row.command.kind === 'interrupt'
    if (stop) cutoffs.set(row.sessionId, Math.max(cutoffs.get(row.sessionId) ?? 0, row._creationTime))
    running.add(row._id)
    void (async () => {
      let error: string | undefined
      try {
        if (!stop && row._creationTime < (cutoffs.get(row.sessionId) ?? 0)) throw new Error('Cancelled by Stop')
        await prepareNativeChatSend(row.sessionId, row.command, row._id, row.uploads ?? [], async image => {
          const url = await client.query(anyApi.remote.imageUrl, { secret, storageId: image.storageId })
          if (!url) throw new Error('Uploaded image is no longer available')
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
          if (!response.ok) throw new Error(`Image download failed (${response.status})`)
          return saveRemoteImage(new Uint8Array(await response.arrayBuffer()), image.mime)
        })
      } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
      await bounded(client.mutation(anyApi.nativeChat.finish, { secret, commandId: row._id, ...(error ? { error } : {}) }))
    })().catch(error => console.error('[native-chat] receipt failed', error)).finally(() => running.delete(row._id))
  }
}
export function scheduleNativeChatPublish(): void {
  if (!current) return
  for (const snapshot of nativeChatManager().all()) {
    if (revisions.get(snapshot.sessionId) === snapshot.revision) continue
    revisions.set(snapshot.sessionId, snapshot.revision)
    states.set(snapshot.sessionId, snapshot)
  }
  if (scheduleTimer || (!states.size && !messages.size)) return
  scheduleTimer = setTimeout(() => { scheduleTimer = undefined; void flush() }, 250)
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native chat mirror request timed out')), 30_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function flush(): Promise<void> {
  if (flushing) { flushAgain = true; return }
  if (!current) return
  flushing = true
  const client = current
  const secret = activeSecret
  try {
    // Snapshot the batch before awaiting: live map iteration can chase newly
    // added sessions indefinitely while the bridge is receiving updates.
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const [id, snapshot] of [...states]) {
      await bounded(client.mutation(anyApi.nativeChat.publish, { secret, snapshot: JSON.parse(JSON.stringify(snapshot)) }))
      if (states.get(id) === snapshot) states.delete(id)
    }
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const [id, rows] of [...messages]) {
      // Freeze this flush's rows: a busy stream cannot monopolize the drain.
      const batchRows = [...rows.values()]
      for (let start = 0; start < batchRows.length; start += 40) {
        const batch = batchRows.slice(start, start + 40)
        await bounded(client.mutation(anyApi.remote.appendMessages, { secret, sessionId: id, native: true, messages: JSON.parse(JSON.stringify(batch)) }))
        for (const row of batch) if (rows.get(row.uid) === row) rows.delete(row.uid)
      }
      if (rows.size === 0 && messages.get(id) === rows) messages.delete(id)
    }
  } catch (error) { console.error('[native-chat] mirror publish failed', error) }
  finally { flushing = false; if (flushAgain) { flushAgain = false; scheduleNativeChatPublish() } }
}
export function stopNativeChatRemote(): void { unsubscribe?.(); unsubscribe = undefined; current = null; if (scheduleTimer) clearTimeout(scheduleTimer); scheduleTimer = undefined }
