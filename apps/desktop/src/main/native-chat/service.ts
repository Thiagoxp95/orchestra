import { dirname, join } from 'node:path'
import { getStoreFilePath, loadPersistedData } from '../persistence'
import { agentChatLog } from '../agent-chat-log'
import { getDaemonClient } from '../daemon-client'
import { ChatInputController } from '../chat-input-controller'
import { NativeChatStore } from './store'
import { NativeChatManager } from './manager'
import { createCodexAdapter } from './codex'
import { createClaudeAdapter } from './claude'
import { nativeLaunch } from './launch'
import { parseLaunchSelection } from '../../shared/launch-selection'
import { parseNativeChatCommand } from '../../shared/native-chat-validation'
import type { NativeChatCommand, NativeChatSnapshot } from '../../shared/native-chat'
import type { TerminalSession } from '../../shared/types'
import type { ChatMessage } from '../agent-message-model'

type Host = {
  session(id: string): TerminalSession | undefined
  isWorking(id: string): boolean
  changed(snapshot: NativeChatSnapshot): void
  handoff?(id: string): void
  messages?(id: string, messages: ChatMessage[]): void
}
let host: Host = { session: id => loadPersistedData().sessions[id], isWorking: () => false, changed: () => {} }
let manager: NativeChatManager | undefined
const preparation = new ChatInputController()
const enrollment = new ChatInputController()
const migrations = new Map<string, Promise<void>>()
export function configureNativeChatHost(options: Host): void { host = options }
export function nativeChatManager(): NativeChatManager {
  if (!manager) {
    const store = new NativeChatStore(join(dirname(getStoreFilePath()), 'native-chat'))
    manager = new NativeChatManager({ load: () => store.load(), save: record => store.save(record), factory: (provider, emit) => provider === 'codex' ? createCodexAdapter(emit) : createClaudeAdapter(emit), onMessages: (id, messages) => { agentChatLog.append(id, messages); host.messages?.(id, messages) } })
    manager.subscribe(snapshot => host.changed(snapshot))
    // Publish restored history only after the singleton has been assigned;
    // log subscribers are allowed to ask who owns this session.
    for (const snapshot of manager.all()) agentChatLog.append(snapshot.sessionId, manager.history(snapshot.sessionId))
  }
  return manager
}
export function nativeChatSnapshot(id: string): NativeChatSnapshot | null { return nativeChatManager().get(id) }
export function registerNativeLaunch(id: string, cwd: string, initialCommand?: string): boolean {
  if (nativeChatSnapshot(id)) return true
  const launch = nativeLaunch(initialCommand)
  if (!launch) return false
  const saved = host.session(id)
  const conversationId = saved?.resumeAgent === launch.provider ? saved.resumeSessionId : undefined
  nativeChatManager().register({ sessionId: id, cwd, ...launch, conversationId: conversationId ?? launch.conversationId })
  return true
}
async function migrate(id: string): Promise<void> {
  if (nativeChatSnapshot(id)) return
  const existing = migrations.get(id)
  if (existing) return existing
  const pending = enrollment.run(id, async check => {
    const assertCurrent = () => { check(); if (!host.session(id)) throw new Error('Session no longer exists') }
    assertCurrent()
    const session = host.session(id)
    if (!session) throw new Error('Session no longer exists')
    const provider = session.processStatus === 'claude' || session.processStatus === 'codex' ? session.processStatus : session.resumeAgent
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Native chat supports Claude and Codex sessions')
    if (host.isWorking(id)) throw new Error('Stop the current CLI turn before switching to native chat')
    const launch = nativeLaunch(session.initialCommand)
    const conversationId = (session.resumeAgent === provider ? session.resumeSessionId : undefined) ?? (launch?.provider === provider ? launch.conversationId : undefined)
    const history = agentChatLog.since(id, -1)
    const daemon = getDaemonClient()
    const live = (await daemon.listSessions()).find(s => s.sessionId === id && s.isAlive)
    assertCurrent()
    // Never silently turn a known conversation into a new thread.
    if (!conversationId && history.length) throw new Error('Conversation id is not available yet; wait for the transcript to finish pairing')
    if (live && !conversationId) throw new Error('Conversation id is not available yet; use a new native session or wait for this conversation to pair')
    if (live) await daemon.kill(id)
    assertCurrent()
    // Ownership is persisted before any provider starts. All future terminal
    // creates for this id will be plain shells even after an app restart.
    nativeChatManager().register({ sessionId: id, provider, cwd: session.cwd, conversationId, settings: parseLaunchSelection(session.initialCommand) }, history)
    host.handoff?.(id)
    await daemon.createOrAttach(id, { cwd: session.cwd, cols: 100, rows: 30 })
    assertCurrent()
  }).finally(() => { migrations.delete(id) })
  migrations.set(id, pending)
  return pending
}
export async function executeNativeChat(id: string, value: unknown, operationId?: string, fingerprint?: string): Promise<NativeChatSnapshot | null> {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid session id')
  const command = parseNativeChatCommand(value)
  // Receipt replay must precede every side effect, including cancelling input
  // preparation. An old acknowledged Stop must not cancel a newer upload.
  if (operationId) {
    const replay = nativeChatManager().replayCommand(id, operationId, fingerprint ?? JSON.stringify(command))
    if (replay) return replay
  }
  if (command.kind === 'interrupt') {
    preparation.cancel(id)
    enrollment.cancel(id)
    if (!nativeChatSnapshot(id)) return null
  }
  if (command.kind === 'start') await migrate(id)
  // A closed pane cannot be resurrected by a stale remote command.
  if (!host.session(id)) throw new Error('Session no longer exists')
  return nativeChatManager().execute(id, command, operationId, fingerprint)
}
export async function prepareNativeChatSend(
  id: string,
  value: NativeChatCommand,
  operationId: string,
  uploads: { storageId: string; mime: string }[],
  download: (image: { storageId: string; mime: string }) => Promise<string>,
): Promise<NativeChatSnapshot | null> {
  const fingerprint = JSON.stringify({ command: value, uploads })
  const replay = nativeChatManager().replayCommand(id, operationId, fingerprint)
  if (replay) return replay
  if (value.kind === 'interrupt') return executeNativeChat(id, value, operationId, fingerprint)
  return preparation.run(id, async check => {
    const paths: string[] = []
    for (const image of uploads) { paths.push(await download(image)); check() }
    check()
    return executeNativeChat(id, value.kind === 'send' ? { ...value, images: paths } : value, operationId, fingerprint)
  })
}
export async function stopNativeChat(id: string): Promise<void> { preparation.cancel(id); enrollment.cancel(id); await nativeChatManager().stop(id) }
