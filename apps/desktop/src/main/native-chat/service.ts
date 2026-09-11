import { dirname, join } from 'node:path'
import { getStoreFilePath, loadPersistedData } from '../persistence'
import { agentChatLog } from '../agent-chat-log'
import { NativeChatStore } from './store'
import { NativeChatManager } from './manager'
import { createCodexAdapter } from './codex'
import { createClaudeAdapter } from './claude'
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
export function nativeChatSnapshot(id: string): NativeChatSnapshot | null { void id; return null }
/** Kept for older connected clients: native commands must never create another SDK owner. */
export async function executeNativeChat(_id: string, _value: unknown, _operationId?: string, _fingerprint?: string): Promise<NativeChatSnapshot | null> {
  throw new Error('Native chat has been retired. Open this session in its terminal.')
}
export async function prepareNativeChatSend(
  _id: string, _value: NativeChatCommand, _operationId: string,
  _uploads: { storageId: string; mime: string }[],
  _download: (image: { storageId: string; mime: string }) => Promise<string>,
): Promise<NativeChatSnapshot | null> {
  throw new Error('Native chat has been retired. Open this session in its terminal.')
}
export async function stopNativeChat(_id: string): Promise<void> { /* Native records are now an immutable migration archive. */ }
