import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getStoreFilePath, loadPersistedData } from '../persistence'
import { agentChatLog } from '../agent-chat-log'
import { getDaemonClient } from '../daemon-client'
import { getSessionAiPid } from '../process-monitor'
import { ChatInputController } from '../chat-input-controller'
import { NativeChatStore } from './store'
import { NativeChatManager, type NativeChatRecord } from './manager'
import { createCodexAdapter } from './codex'
import { createClaudeAdapter } from './claude'
import { createCursorAdapter } from './cursor'
import { exportAcpChatToTerminal } from './cursor-bridge'
import { isIdleTerminalShell } from './terminal-migration'
import { parseLaunchSelection } from '../../shared/launch-selection'
import { parseNativeChatCommand } from '../../shared/native-chat-validation'
import type { NativeChatCommand, NativeChatProvider, NativeChatSettings, NativeChatSnapshot, NativeChatView } from '../../shared/native-chat'
import type { TerminalSession } from '../../shared/types'
import type { ChatMessage } from '../agent-message-model'

type Host = {
  session(id: string): TerminalSession | undefined
  isWorking(id: string): boolean
  changed(snapshot: NativeChatSnapshot): void
  messages?(id: string, messages: ChatMessage[]): void
  /** The CLI conversation the resume tracker paired with this pane. */
  conversation?(id: string): { agent: string; resumeSessionId: string } | null
  /** What the transcript says the CLI is running right now. */
  selection?(id: string): { model?: string; effort?: string } | undefined
}
let host: Host = { session: id => loadPersistedData().sessions[id], isWorking: () => false, changed: () => {} }
let manager: NativeChatManager | undefined
const preparation = new ChatInputController()
const handoffs = new Map<string, Promise<NativeChatSnapshot | null>>()
export function configureNativeChatHost(options: Host): void { host = options }
export function nativeChatManager(): NativeChatManager {
  if (!manager) {
    const store = new NativeChatStore(join(dirname(getStoreFilePath()), 'native-chat'))
    manager = new NativeChatManager({
      load: () => store.load(),
      save: record => store.save(record),
      factory: (provider, emit) => provider === 'codex' ? createCodexAdapter(emit) : provider === 'cursor' ? createCursorAdapter(emit) : createClaudeAdapter(emit),
      onMessages: (id, messages) => { agentChatLog.append(id, messages); host.messages?.(id, messages) },
    })
    manager.subscribe(snapshot => host.changed(snapshot))
    // Publish restored history only after the singleton has been assigned;
    // log subscribers are allowed to ask who owns this session.
    for (const snapshot of manager.all()) if (snapshot.view === 'chat') agentChatLog.append(snapshot.sessionId, manager.history(snapshot.sessionId))
  }
  return manager
}
export function nativeChatSnapshot(id: string): NativeChatSnapshot | null { return nativeChatManager().get(id) }
/** True while the SDK, not the CLI, owns this session's conversation. */
export function nativeChatActive(id: string): boolean { return nativeChatSnapshot(id)?.view === 'chat' }
export function nativeChatRecord(id: string): NativeChatRecord | undefined { return nativeChatManager().record(id) }
export function nativeChatMessages(id: string): ChatMessage[] { return nativeChatActive(id) ? nativeChatManager().history(id) : [] }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitForIdleShell(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = (await getDaemonClient().listSessions()).find(s => s.sessionId === id && s.isAlive)
    if (!live?.pid) return false
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,comm='])
    if (isIdleTerminalShell(live.pid, stdout)) return true
    await sleep(100)
  }
  return false
}

function launchPermission(command?: string): NativeChatSettings['permissionMode'] {
  return /--dangerously-(?:skip-permissions|bypass-approvals-and-sandbox)|--yolo|(?:^|\s)-f(?:\s|$)|--force/.test(command ?? '') ? 'bypass' : 'default'
}

/** Terminal → chat: stop the CLI (its shell and scrollback stay), then open the same conversation over the SDK. */
async function toChat(id: string): Promise<NativeChatSnapshot | null> {
  const session = host.session(id)
  if (!session) throw new Error('Session no longer exists')
  const saved = nativeChatRecord(id)
  const running = session.processStatus
  const provider = (['claude', 'codex', 'cursor'].includes(running ?? '') ? running : saved?.snapshot.provider) as NativeChatProvider | undefined
  if (!provider) throw new Error('Start Claude, Codex or Cursor in this session first')
  if (running === provider && host.isWorking(id)) throw new Error('The agent is mid-turn. Stop it or wait for it to finish, then switch to chat')
  const pairing = host.conversation?.(id)
  const conversationId = (pairing?.agent === provider ? pairing.resumeSessionId : undefined)
    ?? (session.resumeAgent === provider ? session.resumeSessionId : undefined)
    ?? (saved?.snapshot.provider === provider ? saved.snapshot.conversationId : undefined)
  const history = agentChatLog.since(id, -1)
  // Never silently turn a known conversation into a new thread.
  if (!conversationId && history.length) throw new Error('The conversation id is not known yet. Wait a moment for the transcript to pair, then try again')
  const aiPid = running === provider ? getSessionAiPid(id) : undefined
  if (aiPid) {
    try { process.kill(aiPid, 'SIGTERM') } catch { /* already gone */ }
    if (!await waitForIdleShell(id, 6000)) {
      try { process.kill(aiPid, 'SIGKILL') } catch { /* already gone */ }
      if (!await waitForIdleShell(id, 2000)) throw new Error('The agent did not exit. Close it in the terminal, then switch to chat')
    }
  }
  const selection = host.selection?.(id) ?? {}
  const launch = parseLaunchSelection(session.initialCommand)
  const settings: NativeChatSettings = {
    ...(saved?.snapshot.provider === provider ? saved.snapshot.settings : {}),
    ...Object.fromEntries(Object.entries({ model: selection.model ?? launch.model, effort: selection.effort ?? launch.effort }).filter(([, v]) => v)),
    permissionMode: launchPermission(session.initialCommand),
  }
  nativeChatManager().adopt({ sessionId: id, provider, cwd: session.cwd, conversationId, settings }, history)
  return nativeChatManager().execute(id, { kind: 'start' })
}

/** Chat → terminal: close the SDK owner, then relaunch the CLI on the same conversation in the idle shell. */
async function toTerminal(id: string): Promise<NativeChatSnapshot | null> {
  preparation.cancel(id)
  const session = host.session(id)
  const record = await nativeChatManager().release(id)
  // Cursor keeps SDK and CLI chats in separate stores; carry this one across.
  const { provider, conversationId, cwd } = record.snapshot
  if (provider === 'cursor' && conversationId) await exportAcpChatToTerminal(conversationId, cwd)
  // createOrAttach runs the parked record's resume (daemon-client → migrateTerminalConversation).
  await getDaemonClient().createOrAttach(id, { cwd: session?.cwd ?? nativeChatSnapshot(id)!.cwd, cols: 100, rows: 30 })
  return nativeChatSnapshot(id)
}

export function setNativeChatView(id: string, view: unknown): Promise<NativeChatSnapshot | null> {
  if (typeof id !== 'string' || !id || id.length > 200) return Promise.reject(new Error('Invalid session id'))
  if (view !== 'chat' && view !== 'terminal') return Promise.reject(new Error('Invalid view'))
  const pending = handoffs.get(id)
  if (pending) return pending.then(() => setNativeChatView(id, view))
  if ((nativeChatActive(id) ? 'chat' : 'terminal') === (view as NativeChatView)) return Promise.resolve(nativeChatSnapshot(id))
  const run = (view === 'chat' ? toChat(id) : toTerminal(id)).finally(() => { handoffs.delete(id) })
  handoffs.set(id, run)
  return run
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
    if (!nativeChatActive(id)) return null
  }
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
export async function stopNativeChat(id: string): Promise<void> { preparation.cancel(id); await nativeChatManager().stop(id) }
