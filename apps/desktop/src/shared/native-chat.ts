/** The chat protocol is independent of terminal input and provider wire formats. */
export type NativeChatProvider = 'claude' | 'codex'
export type NativeChatSettings = { model?: string; effort?: string }
export type NativeChatModel = { id: string; label: string; efforts: string[] }
export type NativeChatQuestion = {
  id: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}
export type NativeChatRequest = {
  id: string
  kind: 'approval' | 'question'
  title: string
  detail?: string
  questions?: NativeChatQuestion[]
}
export type NativeChatReply = {
  requestId: string
  decision?: 'allow' | 'deny'
  answers?: Record<string, string[]>
}
export type NativeChatStatus = 'stopped' | 'starting' | 'idle' | 'working' | 'compacting' | 'waiting' | 'error'
export type NativeChatSnapshot = {
  sessionId: string
  provider: NativeChatProvider
  cwd: string
  conversationId?: string
  settings: NativeChatSettings
  models?: NativeChatModel[]
  /** Remote projection: queued input still awaiting a host receipt. */
  pendingCommands?: number
  status: NativeChatStatus
  requests: NativeChatRequest[]
  error?: string
  revision: number
}
export type NativeChatCommand =
  | { kind: 'start' }
  | { kind: 'send'; text: string; images?: string[]; steer?: boolean }
  | { kind: 'configure'; settings: NativeChatSettings }
  | { kind: 'compact' }
  | { kind: 'interrupt' }
  | { kind: 'respond'; reply: NativeChatReply }

export function isNativeChatWorking(status: NativeChatStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'compacting' || status === 'waiting'
}

export function nativeChatNormalizedStatus(snapshot: NativeChatSnapshot): import('./agent-session-types').NormalizedAgentSessionStatus {
  const now = Date.now()
  const state = snapshot.requests.length
    ? snapshot.requests.some(r => r.kind === 'approval') ? 'waitingApproval' : 'waitingUserInput'
    : snapshot.status === 'error' ? 'error' : isNativeChatWorking(snapshot.status) ? 'working' : 'idle'
  return { sessionId: snapshot.sessionId, agent: snapshot.provider, state, authority: 'native-chat', connected: true, lastResponsePreview: '', lastTransitionAt: now, updatedAt: now }
}
