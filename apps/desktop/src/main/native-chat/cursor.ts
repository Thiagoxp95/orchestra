/*
 * Portions adapted from T3 Code's CursorAdapter, CursorProvider and ACP runtime.
 *
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Cursor speaks the Agent Client Protocol (ACP) over `cursor-agent acp` stdio.
// Wire facts verified against cursor-agent 2026.09.10:
//  - session/prompt answers only when the turn ENDS ({stopReason}); acceptance
//    is the request being written, so send() never awaits it.
//  - session/update chunks carry no message id. Rows are keyed by their
//    position in the conversation (cursor:<session>:<n>), which session/load
//    replays identically, so reopening upserts the same rows instead of
//    duplicating them.
//  - session/load only knows ACP sessions (~/.cursor/acp-sessions). A chat id
//    recorded from the TUI (~/.cursor/chats) is copied across first; see cursor-bridge.ts.
//  - Model and effort are session config options (session/set_config_option);
//    the effort option's id varies per model (effort, reasoning, reasoning_effort).

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  TEXT_CAP,
  THINKING_CAP,
  TOOL_INPUT_CAP,
  TOOL_RESULT_CAP,
  truncateMiddle,
  type ChatBlock,
} from '../agent-message-model'
import { buildCliChildEnv } from '../node-runtime'
import type { NativeChatReply, NativeChatSettings } from '../../shared/native-chat'
import type { NativeChatAdapter, ProviderEventSink, ProviderOpenOptions } from './provider'
import { JsonLineRpcTransport, type CodexRpcTransport, type JsonRpcId } from './codex-rpc'
import { importTerminalChatToAcp } from './cursor-bridge'

const SETUP_TIMEOUT_MS = 30_000
// t3code's session/load budget: the reply lands only after the whole history replays.
const LOAD_TIMEOUT_MS = 90_000
const MAX_CURSOR_IMAGES = 4
const MAX_CURSOR_IMAGE_BYTES = 3_750_000
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}
const REQUEST_TITLES: Record<string, string> = {
  execute: 'Run command?', edit: 'Apply file changes?', delete: 'Delete files?', move: 'Move files?', fetch: 'Fetch URL?',
}

type JsonObject = Record<string, unknown>
type Segment = { uid: string; kind: 'user' | 'text' | 'thinking'; text: string; images: number }
type ToolState = { uid: string; name: string; input: string }
type PendingPermission = { options: JsonObject[]; resolve(value: unknown): void; reject(error: Error): void }

export type CursorImageLoader = (path: string) => Promise<{ mimeType: string; data: string }>
export type CursorAdapterDependencies = {
  createTransport?: (cwd: string) => CodexRpcTransport | Promise<CodexRpcTransport>
  loadImage?: CursorImageLoader
  importTerminalChat?: (id: string, cwd: string) => Promise<boolean>
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

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

/** Cursor spells one level `extra-high` on some models; the chat speaks `xhigh` everywhere. */
function normalizeEffort(value: string): string {
  return value === 'extra-high' ? 'xhigh' : value
}

function selectValues(option: JsonObject | undefined): string[] {
  return objects(option?.options).flatMap((entry) =>
    'value' in entry ? [stringValue(entry.value)] : objects(entry.options).map((nested) => stringValue(nested.value)),
  ).filter((value): value is string => Boolean(value))
}

function effortOption(configOptions: JsonObject[]): JsonObject | undefined {
  return configOptions.find((option) => option.type === 'select' && option.category !== 'model'
    && /effort|reasoning/i.test(`${String(option.id)} ${String(option.name)}`))
}

function withTimeout<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Cursor agent ${method} timed out`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const loadCursorImage: CursorImageLoader = async (path) => {
  const mimeType = IMAGE_MIME[extname(path).toLowerCase()]
  if (!mimeType) throw new Error(`Unsupported Cursor image type: ${path}`)
  if ((await stat(path)).size > MAX_CURSOR_IMAGE_BYTES) throw new Error(`Cursor image exceeds 3.75 MB: ${path}`)
  return { mimeType, data: (await readFile(path)).toString('base64') }
}

function toolOutput(update: JsonObject): string | undefined {
  const content = objects(update.content).map((entry) => {
    if (entry.type === 'diff') return `Edited ${stringValue(entry.path) ?? 'file'}`
    const inner = isObject(entry.content) ? entry.content : null
    return inner?.type === 'text' ? stringValue(inner.text) : undefined
  }).filter(Boolean).join('\n')
  if (content) return content
  const raw = update.rawOutput
  if (raw === undefined) return undefined
  if (!isObject(raw)) return typeof raw === 'string' ? raw : JSON.stringify(raw)
  const streams = [stringValue(raw.stdout), stringValue(raw.stderr), stringValue(raw.output), stringValue(raw.content)]
  return streams.some(Boolean) ? streams.filter(Boolean).join('\n') : ''
}

/** JsonLineRpcTransport speaks in Codex's name; Cursor's real reason rides in error.data.message. */
function asCursorTransport(rpc: CodexRpcTransport): CodexRpcTransport {
  const relabel = (error: unknown, method?: string) => {
    const data = (error as { data?: unknown })?.data
    const detail = isObject(data) ? stringValue(data.message) : undefined
    const message = errorMessage(error).replace(/Codex app-server/g, 'Cursor agent')
    return Object.assign(new Error(method && detail ? `Cursor ${method} failed: ${detail}` : message), {
      code: (error as { code?: unknown })?.code,
    })
  }
  return {
    request: (method, params) => rpc.request(method, params).catch((error: unknown) => { throw relabel(error, method) }),
    notify: (method, params) => rpc.notify(method, params),
    onNotification: (handler) => rpc.onNotification(handler),
    onRequest: (handler) => rpc.onRequest(handler),
    onDisconnect: (handler) => rpc.onDisconnect((error) => handler(relabel(error))),
    close: () => rpc.close(),
  }
}

function defaultTransport(cwd: string): CodexRpcTransport {
  // t3code launches `cursor-agent acp`; the CLI env's PATH falls back to ~/.local/bin for Finder launches.
  const child = spawn('cursor-agent', ['acp'], { cwd, env: buildCliChildEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  const stop = async () => {
    if (child.exitCode !== null || child.killed) return
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2_000)
      force.unref?.()
      child.once('exit', () => { clearTimeout(force); resolve() })
      child.kill('SIGTERM')
    })
  }
  // session/prompt stays open for the whole turn, so the transport must not time requests out.
  const rpc = new JsonLineRpcTransport(child.stdout, child.stdin, 2_147_483_647, stop)
  child.once('error', (error) => child.stdout.destroy(error))
  child.once('exit', (code, signal) => {
    if (child.stdout.destroyed) return
    const detail = stderr.trim()
    child.stdout.destroy(new Error(`Cursor agent exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
  })
  return asCursorTransport(rpc)
}

class CursorAdapter implements NativeChatAdapter {
  private rpc: CodexRpcTransport | null = null
  private sessionId: string | null = null
  private closed = false
  private settings: NativeChatSettings = {}
  private configOptions: JsonObject[] = []
  private seq = 0
  private segment: Segment | null = null
  private readonly tools = new Map<string, ToolState>()
  private readonly pending = new Map<string, PendingPermission>()
  private promptsInFlight = 0
  private nextRequestId = 1

  constructor(
    private readonly emit: ProviderEventSink,
    private readonly deps: CursorAdapterDependencies,
  ) {}

  async open(options: ProviderOpenOptions): Promise<void> {
    if (this.rpc) throw new Error('Cursor adapter is already open')
    if (this.closed) throw new Error('Cursor adapter is closed')
    this.emit({ kind: 'status', status: 'starting' })
    try {
      const rpc = await (this.deps.createTransport ?? defaultTransport)(options.cwd)
      this.rpc = rpc
      this.bindTransport(rpc)
      await withTimeout(rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
        clientInfo: { name: 'orchestra', version: '1' },
      }), SETUP_TIMEOUT_MS, 'initialize')
      await withTimeout(rpc.request('authenticate', { methodId: 'cursor_login' }), SETUP_TIMEOUT_MS, 'authenticate')
      // Replayed history streams in as session/update BEFORE session/load replies; accept it by id up front.
      this.sessionId = options.conversationId ?? null
      if (options.conversationId) await (this.deps.importTerminalChat ?? importTerminalChatToAcp)(options.conversationId, options.cwd)
      const setup = options.conversationId
        ? await withTimeout(rpc.request('session/load', { sessionId: options.conversationId, cwd: options.cwd, mcpServers: [] }), LOAD_TIMEOUT_MS, 'session/load')
        : await withTimeout(rpc.request('session/new', { cwd: options.cwd, mcpServers: [] }), SETUP_TIMEOUT_MS, 'session/new')
      const sessionId = options.conversationId ?? (isObject(setup) ? stringValue(setup.sessionId) : undefined)
      if (!sessionId) throw new Error('Cursor agent created a session without an id')
      this.sessionId = sessionId
      this.segment = null
      this.configOptions = isObject(setup) ? objects(setup.configOptions) : []
      this.emit({ kind: 'conversation', conversationId: sessionId })
      await this.loadModels(rpc)
      await this.applySettings(options.settings)
      this.emit({ kind: 'status', status: 'idle' })
    } catch (error) {
      const rpc = this.rpc
      this.rpc = null
      this.sessionId = null
      if (rpc) await rpc.close().catch(() => {})
      this.emit({ kind: 'status', status: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async send(input: { text: string; images: string[]; settings: NativeChatSettings }): Promise<void> {
    const rpc = this.requireRpc()
    const sessionId = this.sessionId as string
    if (!input.text && input.images.length === 0) throw new Error('Cursor turn input is empty')
    if (input.images.length > MAX_CURSOR_IMAGES) throw new Error(`Cursor supports at most ${MAX_CURSOR_IMAGES} attached images`)
    const { model, effort, permissionMode } = input.settings
    if ((model && model !== this.settings.model) || (effort && effort !== this.settings.effort) || permissionMode !== this.settings.permissionMode) {
      await this.applySettings(input.settings)
    }
    const prompt: JsonObject[] = []
    if (input.text) prompt.push({ type: 'text', text: input.text })
    for (const path of input.images) prompt.push({ type: 'image', ...await (this.deps.loadImage ?? loadCursorImage)(path) })
    if (this.rpc !== rpc) throw new Error('Cursor send interrupted')
    this.promptsInFlight++
    rpc.request('session/prompt', { sessionId, prompt }).then(
      (result) => this.finishPrompt(rpc, isObject(result) ? stringValue(result.stopReason) : undefined),
      (error: unknown) => this.finishPrompt(rpc, undefined, errorMessage(error)),
    )
    this.segment = null
    const blocks: ChatBlock[] = input.images.map((path) => ({ kind: 'image', alt: basename(path) }))
    if (input.text) blocks.push({ kind: 'text', text: truncateMiddle(input.text, TEXT_CAP, 4_000, 1_500) })
    this.emit({ kind: 'messages', messages: [{ uid: this.nextUid(), role: 'user', blocks, ts: Date.now() }] })
    this.emit({ kind: 'status', status: 'working' })
  }

  async configure(settings: NativeChatSettings): Promise<void> {
    this.requireRpc()
    await this.applySettings(settings)
  }

  async compact(): Promise<void> {
    throw new Error('Cursor does not support compaction')
  }

  async interrupt(): Promise<void> {
    const rpc = this.rpc
    if (!rpc || !this.sessionId) return
    // ACP: the client answers every open permission request `cancelled` when it cancels the turn.
    this.settlePending({ outcome: { outcome: 'cancelled' } })
    if (this.promptsInFlight > 0) rpc.notify('session/cancel', { sessionId: this.sessionId })
    else this.emitCurrentStatus()
  }

  async respond(reply: NativeChatReply): Promise<void> {
    const pending = this.pending.get(reply.requestId)
    if (!pending) throw new Error(`Unknown pending Cursor request: ${reply.requestId}`)
    if (!reply.decision) throw new Error(`Cursor approval reply is missing a decision: ${reply.requestId}`)
    this.pending.delete(reply.requestId)
    pending.resolve(this.permissionOutcome(pending.options, reply.decision))
    this.emit({ kind: 'request-resolved', requestId: reply.requestId })
    this.emitCurrentStatus()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) request.reject(new Error('Cursor adapter closed while waiting for approval'))
    this.pending.clear()
    this.promptsInFlight = 0
    const rpc = this.rpc
    this.rpc = null
    this.sessionId = null
    if (rpc) await rpc.close()
    this.emit({ kind: 'status', status: 'stopped' })
  }

  private bindTransport(rpc: CodexRpcTransport): void {
    rpc.onNotification((method, params) => {
      if (this.rpc === rpc && method === 'session/update') this.handleUpdate(params)
    })
    rpc.onRequest((method, params, id) => {
      if (this.rpc !== rpc || method !== 'session/request_permission') {
        return Promise.reject(Object.assign(new Error(`Unsupported Cursor request: ${method}`), { code: -32601 }))
      }
      return this.handlePermission(params, id)
    })
    rpc.onDisconnect((error) => {
      if (this.rpc !== rpc) return
      this.rpc = null
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
      this.promptsInFlight = 0
      this.emit({ kind: 'status', status: 'error', error: error.message })
      void rpc.close().catch(() => {})
    })
  }

  private async loadModels(rpc: CodexRpcTransport): Promise<void> {
    try {
      const response = await withTimeout(rpc.request('cursor/list_available_models', {}), SETUP_TIMEOUT_MS, 'cursor/list_available_models')
      const models = objects(isObject(response) ? response.models : undefined).flatMap((model) => {
        const id = stringValue(model.value)
        if (!id) return []
        const efforts = selectValues(effortOption(objects(model.configOptions))).map(normalizeEffort)
        return [{ id, label: stringValue(model.name) ?? id, efforts }]
      })
      this.emit({ kind: 'catalog', models })
    } catch {
      // Older CLIs lack the extension: the session's model option still names every model.
      const modelOption = this.configOptions.find((option) => option.category === 'model')
      this.emit({ kind: 'catalog', models: selectValues(modelOption).map((id) => ({ id, label: id, efforts: [] })) })
    }
  }

  private async applySettings(requested: NativeChatSettings): Promise<void> {
    const modelOption = () => this.configOptions.find((option) => option.category === 'model')
    // Parameterized ids (`model[effort=high]`) are TUI launch syntax; ACP takes the base id only.
    const model = requested.model?.split('[')[0]
    if (model && model !== modelOption()?.currentValue) {
      await this.setOption(stringValue(modelOption()?.id) ?? 'model', model)
    }
    const effort = effortOption(this.configOptions)
    if (requested.effort && effort) {
      const value = selectValues(effort).find((candidate) => normalizeEffort(candidate) === requested.effort)
      if (!value) throw new Error(`Unsupported Cursor effort '${requested.effort}' for model '${String(modelOption()?.currentValue)}'`)
      if (value !== effort.currentValue) await this.setOption(String(effort.id), value)
    }
    const currentModel = stringValue(modelOption()?.currentValue)
    const currentEffort = stringValue(effortOption(this.configOptions)?.currentValue)
    this.settings = {
      ...(currentModel ? { model: currentModel } : {}),
      ...(currentEffort ? { effort: normalizeEffort(currentEffort) } : {}),
      ...(requested.permissionMode ? { permissionMode: requested.permissionMode } : {}),
    }
    this.emit({ kind: 'settings', settings: { ...this.settings } })
  }

  private async setOption(configId: string, value: string): Promise<void> {
    const result = await this.requireRpc().request('session/set_config_option', { sessionId: this.sessionId, configId, value })
    if (isObject(result) && Array.isArray(result.configOptions)) this.configOptions = objects(result.configOptions)
  }

  private handleUpdate(rawParams: unknown): void {
    const params = isObject(rawParams) ? rawParams : {}
    const update = isObject(params.update) ? params.update : null
    if (!update || !this.sessionId || params.sessionId !== this.sessionId) return
    const content = isObject(update.content) ? update.content : {}
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return this.appendChunk('user', content)
      case 'agent_message_chunk':
        return this.appendChunk('text', content)
      case 'agent_thought_chunk':
        return this.appendChunk('thinking', content)
      case 'tool_call':
      case 'tool_call_update':
        return this.updateTool(update)
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) this.configOptions = objects(update.configOptions)
    }
  }

  private appendChunk(kind: Segment['kind'], content: JsonObject): void {
    if (!this.segment || this.segment.kind !== kind) {
      this.segment = { uid: this.nextUid(), kind, text: '', images: 0 }
    }
    const segment = this.segment
    if (content.type === 'text' && typeof content.text === 'string') segment.text += content.text
    else if (content.type === 'image') segment.images++
    else return
    if (kind === 'user') {
      const blocks: ChatBlock[] = Array.from({ length: segment.images }, () => ({ kind: 'image', alt: 'Attached image' }))
      if (segment.text) blocks.push({ kind: 'text', text: truncateMiddle(segment.text, TEXT_CAP, 4_000, 1_500) })
      this.emit({ kind: 'messages', messages: [{ uid: segment.uid, role: 'user', blocks }] })
      return
    }
    const text = kind === 'text'
      ? truncateMiddle(segment.text, TEXT_CAP, 4_000, 1_500)
      : truncateMiddle(segment.text, THINKING_CAP, 1_400, 400)
    if (text) this.emit({ kind: 'messages', messages: [{ uid: segment.uid, role: 'assistant', blocks: [{ kind, text }] }] })
  }

  private updateTool(update: JsonObject): void {
    const toolCallId = stringValue(update.toolCallId)
    if (!toolCallId) return
    let tool = this.tools.get(toolCallId)
    if (!tool) {
      this.segment = null
      tool = { uid: this.nextUid(), name: 'tool', input: '' }
      this.tools.set(toolCallId, tool)
    }
    const kind = stringValue(update.kind)
    if (kind) tool.name = kind === 'execute' ? 'command' : kind
    const rawInput = isObject(update.rawInput) ? update.rawInput : {}
    const input = stringValue(rawInput.command) ?? stringValue(update.title)?.replace(/`/g, '')
    if (input) tool.input = truncateMiddle(input, TOOL_INPUT_CAP, 400, 150)
    if (update.sessionUpdate === 'tool_call' || kind || input) {
      this.emit({
        kind: 'messages',
        messages: [{ uid: tool.uid, role: 'assistant', blocks: [{ kind: 'tool', id: toolCallId, name: tool.name, input: tool.input }] }],
      })
    }
    const failed = update.status === 'failed'
    const output = toolOutput(update) ?? (update.status === 'completed' || failed ? '' : undefined)
    if (output === undefined) return
    this.emit({
      kind: 'messages',
      messages: [{
        uid: `${tool.uid}:result`, role: 'tool',
        blocks: [{ kind: 'toolResult', forId: toolCallId, output: truncateMiddle(output, TOOL_RESULT_CAP, 1_700, 600), ...(failed ? { isError: true } : {}) }],
      }],
    })
  }

  private handlePermission(rawParams: unknown, wireId: JsonRpcId): Promise<unknown> {
    const params = isObject(rawParams) ? rawParams : {}
    const options = objects(params.options)
    if (this.settings.permissionMode === 'bypass') return Promise.resolve(this.permissionOutcome(options, 'allow'))
    const toolCall = isObject(params.toolCall) ? params.toolCall : {}
    const rawInput = isObject(toolCall.rawInput) ? toolCall.rawInput : {}
    const detail = [stringValue(rawInput.command) ?? stringValue(toolCall.title)?.replace(/`/g, ''), toolOutput(toolCall)]
      .filter(Boolean).join('\n')
    const requestId = `cursor:${String(wireId)}:${this.nextRequestId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { options, resolve, reject })
      this.emit({
        kind: 'request',
        request: {
          id: requestId, kind: 'approval',
          title: REQUEST_TITLES[stringValue(toolCall.kind) ?? ''] ?? 'Allow tool call?',
          ...(detail ? { detail: truncateMiddle(detail, TOOL_RESULT_CAP, 1_700, 600) } : {}),
        },
      })
      this.emit({ kind: 'status', status: 'waiting' })
    })
  }

  /** Once-only choices on purpose: allow_always would edit Cursor's global allowlist. */
  private permissionOutcome(options: JsonObject[], decision: 'allow' | 'deny'): unknown {
    const [kind, fallback] = decision === 'allow' ? ['allow_once', 'allow-once'] : ['reject_once', 'reject-once']
    const optionId = stringValue(options.find((option) => option.kind === kind)?.optionId) ?? fallback
    return { outcome: { outcome: 'selected', optionId } }
  }

  private settlePending(response: unknown): void {
    for (const [requestId, request] of this.pending) {
      this.pending.delete(requestId)
      request.resolve(response)
      this.emit({ kind: 'request-resolved', requestId })
    }
  }

  private finishPrompt(rpc: CodexRpcTransport, stopReason: string | undefined, error?: string): void {
    if (this.rpc !== rpc || this.closed) return
    this.promptsInFlight = Math.max(0, this.promptsInFlight - 1)
    if (this.promptsInFlight > 0) return
    this.segment = null
    if (error || stopReason === 'refusal') {
      this.emit({ kind: 'status', status: 'error', error: error ?? 'Cursor refused the request' })
    } else {
      this.emitCurrentStatus()
    }
  }

  private emitCurrentStatus(): void {
    this.emit({ kind: 'status', status: this.pending.size > 0 ? 'waiting' : this.promptsInFlight > 0 ? 'working' : 'idle' })
  }

  private nextUid(): string {
    return `cursor:${this.sessionId}:${this.seq++}`
  }

  private requireRpc(): CodexRpcTransport {
    if (this.closed) throw new Error('Cursor adapter is closed')
    if (!this.rpc || !this.sessionId) throw new Error('Cursor adapter is not open')
    return this.rpc
  }
}

export function createCursorAdapter(
  emit: ProviderEventSink,
  dependencies: CursorAdapterDependencies = {},
): NativeChatAdapter {
  return new CursorAdapter(emit, dependencies)
}
