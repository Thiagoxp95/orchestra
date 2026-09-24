import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { ChatBlock, ChatMessage } from '../agent-message-model'
import type { NativeChatReply, NativeChatRequest, NativeChatSettings } from '../../shared/native-chat'
import type { NativeChatAdapter, ProviderEventSink, ProviderOpenOptions } from './provider'
import {
  JsonLineRpcTransport,
  type CodexRpcTransport,
  type JsonRpcId,
} from './codex-rpc'

const APPROVAL_POLICY = 'on-request'
const APPROVALS_REVIEWER = 'user'
const THREAD_SANDBOX = 'workspace-write'
const TURN_SANDBOX = { type: 'workspaceWrite' } as const
/** A bypass handoff keeps the CLI's --dangerously-bypass-approvals-and-sandbox trust level. */
function policy(settings: NativeChatSettings) {
  return settings.permissionMode === 'bypass'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    : { approvalPolicy: APPROVAL_POLICY, sandbox: THREAD_SANDBOX, sandboxPolicy: TURN_SANDBOX }
}
const MAX_RESUMED_HISTORY_ITEMS = 200

type JsonObject = Record<string, unknown>
type ModelInfo = {
  id: string
  label: string
  aliases: string[]
  efforts: Set<string>
  isDefault: boolean
}
type BoundedText = { head: string; tail: string; length: number; truncated: boolean }
type PendingServerRequest = {
  wireId: JsonRpcId
  method: string
  params: JsonObject
  resolve(value: unknown): void
  reject(error: Error): void
}
type PendingTurnStart = { generation: number; acceptedTurnId?: string }

export type CodexAdapterDependencies = {
  createTransport?: () => CodexRpcTransport | Promise<CodexRpcTransport>
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function capEnd(value: string, cap: number): string {
  const result = value.length <= cap ? value : `${value.slice(0, cap - 1)}…`
  return typeof result.toWellFormed === 'function' ? result.toWellFormed() : result
}

function appendBounded(
  previous: BoundedText | undefined,
  delta: string,
  cap: number,
  headCap: number,
  tailCap: number,
): BoundedText {
  const current = previous ?? { head: '', tail: '', length: 0, truncated: false }
  const length = current.length + delta.length
  if (!current.truncated) {
    const combined = `${current.head}${delta}`
    if (length <= cap) return { head: combined, tail: '', length, truncated: false }
    return {
      head: combined.slice(0, headCap), tail: combined.slice(-tailCap), length, truncated: true,
    }
  }
  return {
    head: current.head,
    tail: `${current.tail}${delta}`.slice(-tailCap),
    length,
    truncated: true,
  }
}

function renderBounded(value: BoundedText): string {
  const rendered = value.truncated ? `${value.head}\n…\n${value.tail}` : value.head
  return typeof rendered.toWellFormed === 'function' ? rendered.toWellFormed() : rendered
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (isObject(part)) {
        return stringValue(part.text) ?? stringValue(part.imageUrl) ?? stringValue(part.audioUrl) ?? JSON.stringify(part)
      }
      return String(part)
    }).join('\n')
  }
  if (isObject(value) && Array.isArray(value.content)) return outputText(value.content)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function makeUid(threadId: string, turnId: string, itemId: string, suffix = ''): string {
  return `codex:${threadId}:${turnId}:${itemId}${suffix}`
}

function settingsWith(base: NativeChatSettings, update: NativeChatSettings): NativeChatSettings {
  return {
    ...(typeof base.model === 'string' ? { model: base.model } : {}),
    ...(typeof base.effort === 'string' ? { effort: base.effort } : {}),
    ...(typeof update.model === 'string' ? { model: update.model } : {}),
    ...(typeof update.effort === 'string' ? { effort: update.effort } : {}),
    ...(update.permissionMode ?? base.permissionMode ? { permissionMode: update.permissionMode ?? base.permissionMode } : {}),
  }
}

function defaultTransport(): CodexRpcTransport {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = capEnd(`${stderr}${chunk}`, 8_000)
  })
  const stop = async () => {
    if (child.exitCode !== null || child.killed) return
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2_000)
      force.unref?.()
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
  const rpc = new JsonLineRpcTransport(child.stdout, child.stdin, 30_000, stop)
  child.once('error', (error) => child.stdout.destroy(error))
  child.once('exit', (code, signal) => {
    if (child.stdout.destroyed) return
    const detail = stderr.trim()
    child.stdout.destroy(new Error(
      `Codex app-server exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
    ))
  })
  return rpc
}

class CodexAdapter implements NativeChatAdapter {
  private rpc: CodexRpcTransport | null = null
  private threadId: string | null = null
  private cwd: string | null = null
  private activeTurnId: string | null = null
  private settings: NativeChatSettings = {}
  private closed = false
  private models: ModelInfo[] = []
  private readonly textByItem = new Map<string, BoundedText>()
  private readonly thinkingByItem = new Map<string, BoundedText>()
  private readonly outputByItem = new Map<string, BoundedText>()
  private readonly pending = new Map<string, PendingServerRequest>()
  private readonly requestIdByWireId = new Map<string, string>()
  private readonly resolvedRequestIds = new Set<string>()
  private readonly pendingTurnStarts = new Set<PendingTurnStart>()
  private readonly seenStartedTurnIds = new Set<string>()
  private cancelGeneration = 0
  private compactInFlight = false
  private nextRequestId = 1

  constructor(
    private readonly emit: ProviderEventSink,
    private readonly deps: CodexAdapterDependencies,
  ) {}

  async open(options: ProviderOpenOptions): Promise<void> {
    if (this.rpc) throw new Error('Codex adapter is already open')
    this.closed = false
    this.cancelGeneration++
    this.threadId = null
    this.cwd = null
    this.activeTurnId = null
    this.compactInFlight = false
    this.pendingTurnStarts.clear()
    this.seenStartedTurnIds.clear()
    this.models = []
    this.textByItem.clear()
    this.thinkingByItem.clear()
    this.outputByItem.clear()
    this.resolvedRequestIds.clear()
    this.emit({ kind: 'status', status: 'starting' })
    try {
      const rpc = await (this.deps.createTransport?.() ?? defaultTransport())
      this.rpc = rpc
      this.bindTransport(rpc)
      await rpc.request('initialize', {
        clientInfo: { name: 'orchestra', title: 'Orchestra', version: '1.21.67' },
        capabilities: { experimentalApi: true },
      })
      rpc.notify('initialized', {})
      await this.loadModels()
      this.settings = this.resolveInitialSettings(options.settings)
      this.validateSettings(this.settings)
      const common = {
        cwd: options.cwd,
        ...(this.settings.model ? { model: this.settings.model } : {}),
        approvalPolicy: policy(this.settings).approvalPolicy,
        approvalsReviewer: APPROVALS_REVIEWER,
        sandbox: policy(this.settings).sandbox,
      }
      const result = await rpc.request(
        options.conversationId ? 'thread/resume' : 'thread/start',
        options.conversationId
          ? { threadId: options.conversationId, ...common, excludeTurns: false }
          : common,
      )
      const thread = isObject(result) && isObject(result.thread) ? result.thread : null
      const threadId = stringValue(thread?.id)
      if (!threadId) throw new Error('Codex app-server returned a thread without an id')
      this.threadId = threadId
      this.cwd = options.cwd
      this.emit({ kind: 'conversation', conversationId: threadId })
      this.emit({ kind: 'settings', settings: { ...this.settings } })
      if (options.conversationId) this.emitResumedHistory(result, threadId)
      this.emit({ kind: 'status', status: 'idle' })
    } catch (error) {
      const rpc = this.rpc
      this.rpc = null
      this.threadId = null
      this.cwd = null
      this.activeTurnId = null
      this.closed = true
      if (rpc) await rpc.close().catch(() => {})
      this.closed = false
      this.emit({ kind: 'status', status: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async send(input: { text: string; images: string[]; settings: NativeChatSettings }): Promise<void> {
    const generation = this.cancelGeneration
    const effective = settingsWith(this.settings, input.settings)
    this.validateSettings(effective)
    if (!input.text && input.images.length === 0) throw new Error('Codex turn input is empty')
    const pendingStart: PendingTurnStart = { generation }
    this.pendingTurnStarts.add(pendingStart)
    const turnInput: JsonObject[] = []
    if (input.text) turnInput.push({ type: 'text', text: input.text })
    for (const path of input.images) turnInput.push({ type: 'localImage', path })
    try {
      const rpc = await this.ensureRpc(generation)
      const threadId = this.requireThreadId()
      const result = await rpc.request('turn/start', {
        threadId,
        input: turnInput,
        ...(effective.model ? { model: effective.model } : {}),
        ...(effective.effort ? { effort: effective.effort } : {}),
        approvalPolicy: policy(effective).approvalPolicy,
        approvalsReviewer: APPROVALS_REVIEWER,
        sandboxPolicy: policy(effective).sandboxPolicy,
      })
      if (generation !== this.cancelGeneration) throw new Error('Codex turn start cancelled')
      const turn = isObject(result) && isObject(result.turn) ? result.turn : null
      const acceptedTurnId = stringValue(turn?.id)
      if (!acceptedTurnId) throw new Error('Codex app-server accepted a turn without an id')
      pendingStart.acceptedTurnId = acceptedTurnId
      if (this.seenStartedTurnIds.delete(acceptedTurnId)) this.pendingTurnStarts.delete(pendingStart)
      this.settings = effective
      const blocks: ChatBlock[] = []
      if (input.text) blocks.push({ kind: 'text', text: input.text })
      for (const path of input.images) blocks.push({ kind: 'image', alt: basename(path) })
      this.emit({
        kind: 'messages',
        messages: [{ uid: makeUid(threadId, acceptedTurnId, 'user'), role: 'user', blocks }],
      })
      this.emit({ kind: 'status', status: 'working' })
    } catch (error) {
      this.pendingTurnStarts.delete(pendingStart)
      if (generation !== this.cancelGeneration) throw new Error('Codex turn start cancelled')
      throw error
    }
  }

  async configure(settings: NativeChatSettings): Promise<void> {
    const effective = settingsWith(this.settings, settings)
    this.validateSettings(effective)
    this.settings = effective
  }

  async compact(): Promise<void> {
    const generation = this.cancelGeneration
    this.compactInFlight = true
    try {
      const rpc = await this.ensureRpc(generation)
      await rpc.request('thread/compact/start', { threadId: this.requireThreadId() })
      if (generation !== this.cancelGeneration) throw new Error('Codex compaction cancelled')
      this.emit({ kind: 'status', status: 'compacting' })
    } catch (error) {
      this.compactInFlight = false
      if (generation !== this.cancelGeneration) throw new Error('Codex compaction cancelled')
      throw error
    }
  }

  async interrupt(): Promise<void> {
    const rpc = this.rpc
    const settledRequests = this.pending.size > 0
    this.settlePendingRequests()
    if (settledRequests) await Promise.resolve()
    if (this.pendingTurnStarts.size > 0 || this.compactInFlight) {
      this.cancelGeneration++
      this.pendingTurnStarts.clear()
      this.seenStartedTurnIds.clear()
      this.compactInFlight = false
      this.activeTurnId = null
      this.rpc = null
      if (rpc) await rpc.close()
      this.emit({ kind: 'status', status: 'idle' })
      return
    }
    if (!this.activeTurnId || !rpc) return
    await rpc.request('turn/interrupt', {
      threadId: this.requireThreadId(),
      turnId: this.activeTurnId,
    })
  }

  async respond(reply: NativeChatReply): Promise<void> {
    const request = this.pending.get(reply.requestId)
    if (!request) throw new Error(`Unknown pending Codex request: ${reply.requestId}`)
    let response: unknown
    if (request.method === 'item/tool/requestUserInput') {
      if (!reply.answers) throw new Error(`Codex question reply is missing answers: ${reply.requestId}`)
      response = {
        answers: Object.fromEntries(
          Object.entries(reply.answers).map(([id, answers]) => [id, { answers }]),
        ),
      }
    } else {
      if (!reply.decision) throw new Error(`Codex approval reply is missing a decision: ${reply.requestId}`)
      response = this.approvalResponse(request, reply.decision)
    }
    this.pending.delete(reply.requestId)
    this.requestIdByWireId.delete(String(request.wireId))
    request.resolve(response)
    this.resolveRequest(reply.requestId)
    this.emitCurrentStatus()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelGeneration++
    this.pendingTurnStarts.clear()
    this.seenStartedTurnIds.clear()
    this.compactInFlight = false
    for (const request of this.pending.values()) {
      request.reject(new Error('Codex adapter closed while waiting for user input'))
    }
    this.pending.clear()
    this.requestIdByWireId.clear()
    this.textByItem.clear()
    this.thinkingByItem.clear()
    this.outputByItem.clear()
    this.resolvedRequestIds.clear()
    const rpc = this.rpc
    this.rpc = null
    this.threadId = null
    this.cwd = null
    this.activeTurnId = null
    if (rpc) await rpc.close()
    this.emit({ kind: 'status', status: 'stopped' })
  }

  private bindTransport(rpc: CodexRpcTransport): void {
    rpc.onNotification((method, params) => {
      if (this.rpc === rpc) this.handleNotification(method, params)
    })
    rpc.onRequest((method, params, id) => {
      if (this.rpc !== rpc) {
        return Promise.reject(Object.assign(new Error('Stale Codex app-server request'), { code: -32603 }))
      }
      return this.handleServerRequest(method, params, id)
    })
    rpc.onDisconnect((error) => {
      if (this.rpc === rpc) {
        this.handleDisconnect(error)
        void rpc.close().catch(() => {})
      }
    })
  }

  private async ensureRpc(generation: number): Promise<CodexRpcTransport> {
    if (this.rpc) return this.rpc
    if (this.closed) throw new Error('Codex adapter is closed')
    const cwd = this.cwd
    const threadId = this.threadId
    if (!cwd || !threadId) throw new Error('Codex adapter has no thread to resume')
    this.emit({ kind: 'status', status: 'starting' })
    const rpc = await (this.deps.createTransport?.() ?? defaultTransport())
    if (generation !== this.cancelGeneration) {
      await rpc.close()
      throw new Error('Codex operation cancelled')
    }
    this.rpc = rpc
    this.bindTransport(rpc)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'orchestra', title: 'Orchestra', version: '1.21.67' },
        capabilities: { experimentalApi: true },
      })
      if (generation !== this.cancelGeneration) throw new Error('Codex operation cancelled')
      rpc.notify('initialized', {})
      await this.loadModels()
      if (generation !== this.cancelGeneration) throw new Error('Codex operation cancelled')
      this.validateSettings(this.settings)
      const result = await rpc.request('thread/resume', {
        threadId,
        cwd,
        ...(this.settings.model ? { model: this.settings.model } : {}),
        excludeTurns: false,
        approvalPolicy: policy(this.settings).approvalPolicy,
        approvalsReviewer: APPROVALS_REVIEWER,
        sandbox: policy(this.settings).sandbox,
      })
      if (generation !== this.cancelGeneration) throw new Error('Codex operation cancelled')
      const thread = isObject(result) && isObject(result.thread) ? result.thread : null
      const resumedThreadId = stringValue(thread?.id)
      if (!resumedThreadId) throw new Error('Codex app-server resumed a thread without an id')
      this.threadId = resumedThreadId
      this.emit({ kind: 'conversation', conversationId: resumedThreadId })
      this.emit({ kind: 'settings', settings: { ...this.settings } })
      this.emitResumedHistory(result, resumedThreadId)
      this.emit({ kind: 'status', status: 'idle' })
      return rpc
    } catch (error) {
      if (this.rpc === rpc) this.rpc = null
      await rpc.close().catch(() => {})
      if (generation === this.cancelGeneration) {
        this.emit({ kind: 'status', status: 'error', error: errorMessage(error) })
      }
      throw error
    }
  }

  private async loadModels(): Promise<void> {
    const rpc = this.requireRpc()
    const models: ModelInfo[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    try {
      do {
        const response = await rpc.request('model/list', {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        })
        if (!isObject(response) || !Array.isArray(response.data)) return
        for (const raw of response.data) {
          if (!isObject(raw)) continue
          const id = stringValue(raw.id) ?? stringValue(raw.model)
          if (!id) continue
          const label = stringValue(raw.displayName) ?? id
          const aliases = [stringValue(raw.id), stringValue(raw.model)].filter(
            (value): value is string => Boolean(value),
          )
          const efforts = new Set<string>()
          if (Array.isArray(raw.supportedReasoningEfforts)) {
            for (const option of raw.supportedReasoningEfforts) {
              if (isObject(option) && stringValue(option.reasoningEffort)) {
                efforts.add(option.reasoningEffort as string)
              }
            }
          }
          models.push({ id, label, aliases, efforts, isDefault: raw.isDefault === true })
        }
        const nextCursor = stringValue(response.nextCursor)
        cursor = nextCursor && !seenCursors.has(nextCursor) ? nextCursor : undefined
        if (cursor) seenCursors.add(cursor)
      } while (cursor)
      this.models = models
      this.emit({
        kind: 'catalog',
        models: models.map((model) => ({
          id: model.id,
          label: model.label,
          efforts: [...model.efforts],
        })),
      })
    } catch {
      this.models = []
    }
  }

  private validateSettings(settings: NativeChatSettings): void {
    if (settings.model !== undefined && !settings.model.trim()) throw new Error('Codex model cannot be empty')
    if (settings.effort !== undefined && !settings.effort.trim()) throw new Error('Codex effort cannot be empty')
    if (this.models.length === 0) return
    const model = settings.model
      ? this.models.find((candidate) => candidate.aliases.includes(settings.model as string))
      : this.models.find((candidate) => candidate.isDefault) ?? this.models.find((candidate) => candidate.efforts.size > 0)
    if (settings.model && !model) throw new Error(`Unknown model for Codex: ${settings.model}`)
    if (settings.effort && model && model.efforts.size > 0 && !model.efforts.has(settings.effort)) {
      throw new Error(`Unsupported Codex effort '${settings.effort}' for model '${model.id}'`)
    }
  }

  private resolveInitialSettings(settings: NativeChatSettings): NativeChatSettings {
    const resolved = settingsWith({}, settings)
    if (resolved.model) return resolved
    const advertised = this.models.find((model) => model.isDefault) ?? this.models[0]
    return advertised ? { ...resolved, model: advertised.id } : resolved
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = isObject(rawParams) ? rawParams : {}
    const notificationThreadId = stringValue(params.threadId)
    if (notificationThreadId && this.threadId && notificationThreadId !== this.threadId) return
    switch (method) {
      case 'turn/started': {
        const turn = isObject(params.turn) ? params.turn : null
        const turnId = stringValue(turn?.id)
        if (turnId) {
          this.activeTurnId = turnId
          if (this.pendingTurnStarts.size > 0) this.seenStartedTurnIds.add(turnId)
          for (const pending of this.pendingTurnStarts) {
            if (pending.acceptedTurnId === turnId) this.pendingTurnStarts.delete(pending)
          }
        }
        this.emit({ kind: 'status', status: 'working' })
        return
      }
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : null
        const turnId = stringValue(turn?.id)
        if (turnId && turnId !== this.activeTurnId) return
        this.activeTurnId = null
        if (turnId) this.seenStartedTurnIds.delete(turnId)
        if (turn?.status === 'failed') {
          const error = isObject(turn.error) ? stringValue(turn.error.message) : undefined
          this.emit({ kind: 'status', status: 'error', ...(error ? { error } : {}) })
        } else {
          this.emitCurrentStatus()
        }
        return
      }
      case 'error': {
        const error = isObject(params.error) ? stringValue(params.error.message) : undefined
        if (params.willRetry !== true) this.activeTurnId = null
        this.emit({
          kind: 'status', status: params.willRetry === true ? 'working' : 'error',
          ...(error ? { error } : {}),
        })
        return
      }
      case 'thread/compacted':
        this.activeTurnId = null
        this.compactInFlight = false
        this.emitCurrentStatus()
        return
      case 'serverRequest/resolved': {
        const requestId = this.requestIdByWireId.get(String(params.requestId))
        if (requestId) this.resolveRequest(requestId)
        return
      }
      case 'item/agentMessage/delta':
        this.appendStream(params, this.textByItem, 'text', stringValue(params.delta) ?? '')
        return
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.appendStream(params, this.thinkingByItem, 'thinking', stringValue(params.delta) ?? '')
        return
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.appendToolOutput(params, stringValue(params.delta) ?? '')
        return
      case 'item/mcpToolCall/progress':
        this.appendToolOutput(params, `${stringValue(params.message) ?? ''}\n`)
        return
      case 'item/started':
      case 'item/completed':
        this.emitItem(params, method === 'item/completed')
    }
  }

  private appendStream(
    params: JsonObject,
    store: Map<string, BoundedText>,
    kind: 'text' | 'thinking',
    delta: string,
  ): void {
    const threadId = stringValue(params.threadId)
    const turnId = stringValue(params.turnId)
    const itemId = stringValue(params.itemId)
    if (!threadId || !turnId || !itemId || !delta) return
    const uid = makeUid(threadId, turnId, itemId)
    const bounded = kind === 'text'
      ? appendBounded(store.get(uid), delta, 6_000, 4_000, 1_500)
      : appendBounded(store.get(uid), delta, 2_000, 1_400, 400)
    store.set(uid, bounded)
    const text = renderBounded(bounded)
    this.emitMessage({ uid, role: 'assistant', blocks: [{ kind, text }] })
  }

  private appendToolOutput(params: JsonObject, delta: string): void {
    const threadId = stringValue(params.threadId)
    const turnId = stringValue(params.turnId)
    const itemId = stringValue(params.itemId)
    if (!threadId || !turnId || !itemId || !delta) return
    const uid = makeUid(threadId, turnId, itemId, ':result')
    const bounded = appendBounded(this.outputByItem.get(uid), delta, 2_500, 1_700, 600)
    this.outputByItem.set(uid, bounded)
    const output = renderBounded(bounded)
    this.emitMessage({
      uid, role: 'tool', blocks: [{ kind: 'toolResult', forId: itemId, output }],
    })
  }

  private emitResumedHistory(result: unknown, threadId: string): void {
    const thread = isObject(result) && isObject(result.thread) ? result.thread : null
    const turns = thread && Array.isArray(thread.turns) ? thread.turns.filter(isObject) : []
    const history = turns.flatMap((turn) => {
      const turnId = stringValue(turn.id)
      if (!turnId || !Array.isArray(turn.items)) return []
      const seconds = typeof turn.completedAt === 'number'
        ? turn.completedAt
        : typeof turn.startedAt === 'number' ? turn.startedAt : undefined
      return turn.items.filter(isObject).map((item) => ({ turnId, item, seconds }))
    }).slice(-MAX_RESUMED_HISTORY_ITEMS)

    for (const { turnId, item, seconds } of history) {
      const ts = seconds === undefined ? undefined : seconds * 1_000
      if (item.type === 'userMessage') {
        this.emitHistoricalUserMessage(threadId, turnId, item, ts)
      } else {
        this.emitItem({
          threadId,
          turnId,
          item,
          ...(ts === undefined ? {} : { completedAtMs: ts }),
        }, true)
      }
    }
  }

  private emitHistoricalUserMessage(
    threadId: string,
    turnId: string,
    item: JsonObject,
    ts: number | undefined,
  ): void {
    if (!Array.isArray(item.content)) return
    const blocks: ChatBlock[] = []
    for (const raw of item.content) {
      if (!isObject(raw)) continue
      if (raw.type === 'text' && typeof raw.text === 'string') {
        blocks.push({ kind: 'text', text: capEnd(raw.text, 6_000) })
      } else if (raw.type === 'localImage' && typeof raw.path === 'string') {
        blocks.push({ kind: 'image', alt: basename(raw.path) })
      } else if (raw.type === 'image' && typeof raw.url === 'string') {
        blocks.push({ kind: 'image', alt: capEnd(basename(raw.url), 600) })
      }
      if (blocks.length === 32) break
    }
    if (blocks.length === 0) return
    this.emitMessage({
      uid: makeUid(threadId, turnId, 'user'),
      role: 'user',
      blocks,
      ...(ts === undefined ? {} : { ts }),
    })
  }

  private emitItem(params: JsonObject, completed: boolean): void {
    const threadId = stringValue(params.threadId)
    const turnId = stringValue(params.turnId)
    const item = isObject(params.item) ? params.item : null
    const itemId = stringValue(item?.id)
    const type = stringValue(item?.type)
    if (!threadId || !turnId || !item || !itemId || !type || type === 'userMessage') return
    const tsValue = completed ? params.completedAtMs : params.startedAtMs
    const ts = typeof tsValue === 'number' ? tsValue : undefined
    const uid = makeUid(threadId, turnId, itemId)
    const withTs = (message: ChatMessage): ChatMessage => ts === undefined ? message : { ...message, ts }
    if (type === 'agentMessage' || type === 'plan') {
      const text = capEnd(stringValue(item.text) ?? '', 6_000)
      if (text) {
        this.emitMessage(withTs({ uid, role: 'assistant', blocks: [{ kind: 'text', text }] }))
      }
      return
    }
    if (type === 'reasoning') {
      const values = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].filter((value): value is string => typeof value === 'string')
      const text = capEnd(values.join('\n'), 2_000)
      if (text) {
        this.emitMessage(withTs({ uid, role: 'assistant', blocks: [{ kind: 'thinking', text }] }))
      }
      return
    }
    if (type === 'functionCallOutput') {
      this.emitToolResult(threadId, turnId, itemId, outputText(item.output), false, ts)
      return
    }
    const tool = this.describeTool(item)
    if (!tool) return
    this.emitMessage(withTs({
      uid, role: 'assistant',
      blocks: [{ kind: 'tool', id: itemId, name: tool.name, input: capEnd(tool.input, 600) }],
    }))
    if (completed && tool.output !== undefined) {
      this.emitToolResult(threadId, turnId, itemId, tool.output, tool.isError ?? false, ts)
    }
  }

  private describeTool(item: JsonObject): { name: string; input: string; output?: string; isError?: boolean } | null {
    switch (item.type) {
      case 'commandExecution':
        return {
          name: 'command', input: stringValue(item.command) ?? '',
          ...(item.aggregatedOutput !== null && item.aggregatedOutput !== undefined
            ? { output: outputText(item.aggregatedOutput), isError: item.status === 'failed' }
            : {}),
        }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : []
        return {
          name: 'fileChange', input: changes.map((change) => stringValue(change.path) ?? '').filter(Boolean).join(', '),
          output: changes.map((change) => stringValue(change.diff) ?? '').filter(Boolean).join('\n'),
          isError: item.status === 'failed',
        }
      }
      case 'mcpToolCall': {
        const error = isObject(item.error) ? stringValue(item.error.message) : undefined
        return {
          name: `${stringValue(item.server) ?? 'mcp'}/${stringValue(item.tool) ?? 'tool'}`,
          input: outputText(item.arguments),
          ...(error ? { output: error, isError: true } : item.result ? { output: outputText(item.result) } : {}),
        }
      }
      case 'dynamicToolCall':
        return {
          name: [stringValue(item.namespace), stringValue(item.tool) ?? 'tool'].filter(Boolean).join('/'),
          input: outputText(item.arguments),
          ...(Array.isArray(item.contentItems)
            ? { output: outputText(item.contentItems), isError: item.success === false }
            : {}),
        }
      case 'webSearch':
        return { name: 'webSearch', input: stringValue(item.query) ?? '', ...(item.results ? { output: outputText(item.results) } : {}) }
      case 'imageView':
        return { name: 'viewImage', input: stringValue(item.path) ?? '' }
      case 'imageGeneration':
        return {
          name: 'imageGeneration', input: stringValue(item.revisedPrompt) ?? '',
          output: stringValue(item.savedPath) ?? stringValue(item.result) ?? '',
          isError: item.status === 'failed',
        }
      case 'collabAgentToolCall':
        return { name: stringValue(item.tool) ?? 'agent', input: stringValue(item.prompt) ?? '' }
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return { name: String(item.type), input: stringValue(item.review) ?? '' }
      default:
        return null
    }
  }

  private emitToolResult(
    threadId: string,
    turnId: string,
    itemId: string,
    rawOutput: string,
    isError: boolean,
    ts?: number,
  ): void {
    const uid = makeUid(threadId, turnId, itemId, ':result')
    const output = capEnd(rawOutput, 2_500)
    const message: ChatMessage = {
      uid, role: 'tool',
      blocks: [{ kind: 'toolResult', forId: itemId, output, ...(isError ? { isError: true } : {}) }],
      ...(ts === undefined ? {} : { ts }),
    }
    this.emitMessage(message)
  }

  private emitMessage(message: ChatMessage): void {
    this.emit({ kind: 'messages', messages: [message] })
  }

  private handleServerRequest(method: string, rawParams: unknown, wireId: JsonRpcId): Promise<unknown> {
    const params = isObject(rawParams) ? rawParams : {}
    const requestId = `codex:${String(wireId)}:${this.nextRequestId++}`
    if (this.pending.has(requestId)) return Promise.reject(new Error(`Duplicate Codex request: ${requestId}`))
    let request: NativeChatRequest
    if (method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions.filter(isObject) : []
      request = {
        id: requestId, kind: 'question', title: 'Codex needs your input',
        questions: questions.map((question, index) => ({
          id: stringValue(question.id) ?? String(index),
          question: stringValue(question.question) ?? stringValue(question.header) ?? 'Choose an option',
          options: Array.isArray(question.options)
            ? question.options.filter(isObject).map((option) => ({
              label: stringValue(option.label) ?? '',
              ...(stringValue(option.description) ? { description: option.description as string } : {}),
            }))
            : [],
        })),
      }
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'mcpServer/elicitation/request'
    ) {
      request = this.describeApproval(requestId, method, params)
    } else {
      return Promise.reject(Object.assign(new Error(`Unsupported Codex server request: ${method}`), { code: -32601 }))
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { wireId, method, params, resolve, reject })
      this.requestIdByWireId.set(String(wireId), requestId)
      this.emit({ kind: 'request', request })
      this.emit({ kind: 'status', status: 'waiting' })
    })
  }

  private describeApproval(requestId: string, method: string, params: JsonObject): NativeChatRequest {
    if (method === 'item/commandExecution/requestApproval') {
      return {
        id: requestId, kind: 'approval', title: 'Run command?',
        detail: [stringValue(params.command), stringValue(params.reason)].filter(Boolean).join('\n') || undefined,
      }
    }
    if (method === 'item/fileChange/requestApproval') {
      return { id: requestId, kind: 'approval', title: 'Apply file changes?', detail: stringValue(params.reason) }
    }
    if (method === 'item/permissions/requestApproval') {
      return { id: requestId, kind: 'approval', title: 'Grant additional permissions?', detail: outputText(params.permissions) }
    }
    return {
      id: requestId, kind: 'approval',
      title: `Allow ${stringValue(params.serverName) ?? 'MCP server'}?`,
      detail: stringValue(params.message),
    }
  }

  private approvalResponse(request: PendingServerRequest, decision: 'allow' | 'deny'): unknown {
    if (request.method === 'mcpServer/elicitation/request') {
      return decision === 'allow'
        ? { action: 'accept', ...(this.elicitationContent(request.params) ? { content: this.elicitationContent(request.params) } : {}) }
        : { action: 'decline' }
    }
    if (request.method === 'item/permissions/requestApproval') {
      return decision === 'allow'
        ? { permissions: request.params.permissions ?? {}, scope: 'turn' }
        : { permissions: {}, scope: 'turn' }
    }
    if (decision === 'allow') return { decision: 'accept' }
    const available = Array.isArray(request.params.availableDecisions) ? request.params.availableDecisions : []
    return { decision: available.includes('decline') || available.length === 0 ? 'decline' : 'cancel' }
  }

  private elicitationContent(params: JsonObject): JsonObject | undefined {
    const schema = isObject(params.requestedSchema) ? params.requestedSchema : null
    const properties = schema && isObject(schema.properties) ? schema.properties : null
    if (!properties) return undefined
    const content: JsonObject = {}
    for (const [name, raw] of Object.entries(properties)) {
      if (!isObject(raw)) continue
      if (raw.default !== undefined && raw.default !== null) content[name] = raw.default
      else if (Array.isArray(raw.enum) && raw.enum.length > 0) content[name] = raw.enum[0]
      else if (Array.isArray(raw.oneOf) && isObject(raw.oneOf[0])) content[name] = raw.oneOf[0].const
      else if (raw.type === 'boolean') content[name] = false
    }
    return content
  }

  private resolveRequest(requestId: string): void {
    if (this.resolvedRequestIds.has(requestId)) return
    this.resolvedRequestIds.add(requestId)
    this.emit({ kind: 'request-resolved', requestId })
  }

  private settlePendingRequests(): void {
    for (const [requestId, request] of this.pending) {
      const response = request.method === 'item/tool/requestUserInput'
        ? { answers: {} }
        : this.approvalResponse(request, 'deny')
      this.pending.delete(requestId)
      this.requestIdByWireId.delete(String(request.wireId))
      request.resolve(response)
      this.resolveRequest(requestId)
    }
  }

  private emitCurrentStatus(): void {
    this.emit({
      kind: 'status',
      status: this.pending.size > 0 ? 'waiting' : this.activeTurnId ? 'working' : 'idle',
    })
  }

  private handleDisconnect(error: Error): void {
    if (this.closed) return
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.requestIdByWireId.clear()
    this.pendingTurnStarts.clear()
    this.seenStartedTurnIds.clear()
    this.compactInFlight = false
    this.activeTurnId = null
    this.rpc = null
    this.emit({ kind: 'status', status: 'error', error: error.message })
  }

  private requireRpc(): CodexRpcTransport {
    if (!this.rpc) throw new Error('Codex adapter is not open')
    return this.rpc
  }

  private requireThreadId(): string {
    if (!this.threadId) throw new Error('Codex adapter has no open thread')
    return this.threadId
  }
}

export function createCodexAdapter(
  emit: ProviderEventSink,
  dependencies: CodexAdapterDependencies = {},
): NativeChatAdapter {
  return new CodexAdapter(emit, dependencies)
}
