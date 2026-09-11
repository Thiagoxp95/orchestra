/*
 * Portions adapted from T3 Code's ClaudeAdapter.
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

import {
  getSessionMessages,
  query,
  type CanUseTool,
  type GetSessionMessagesOptions,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TEXT_CAP,
  THINKING_CAP,
  TOOL_RESULT_CAP,
  MAX_BLOCKS_PER_MESSAGE,
  parseClaudeLine,
  summarizeToolInput,
  truncateMiddle,
  type ChatBlock,
  type ChatMessage,
} from '../agent-message-model'
import type { NativeChatSettings } from '../../shared/native-chat'
import type { NativeChatRequest, NativeChatStatus } from '../../shared/native-chat'
import type { NativeChatAdapter, ProviderEventSink, ProviderOpenOptions } from './provider'

export type ClaudeQueryLike = AsyncIterable<SDKMessage>
  & Pick<Query, 'interrupt' | 'setModel' | 'applyFlagSettings' | 'initializationResult' | 'close'>

export type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQueryLike

type ClaudeImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
export type ClaudeImageLoader = (path: string) => Promise<{
  mediaType: ClaudeImageMediaType
  bytes: Uint8Array
}>
export type ClaudeSessionMessageLoader = (
  sessionId: string,
  options: GetSessionMessagesOptions,
) => Promise<SessionMessage[]>
export type ClaudeExecutableResolver = () => string | undefined

const MAX_CLAUDE_IMAGES = 4
const MAX_CLAUDE_HISTORY_MESSAGES = 400
// The strictest official transport limit is 5 MB after base64 encoding.
const MAX_CLAUDE_IMAGE_BYTES = 3_750_000

export function resolvePackagedClaudeExecutable(
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  platform = process.platform,
  arch = process.arch,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!resourcesPath) return undefined
  const packageSuffixes = platform === 'linux'
    ? [`${platform}-${arch}`, `${platform}-${arch}-musl`]
    : [`${platform}-${arch}`]
  const executable = platform === 'win32' ? 'claude.exe' : 'claude'
  for (const suffix of packageSuffixes) {
    const candidate = join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${suffix}`,
      executable,
    )
    if (exists(candidate)) return candidate
  }
  return undefined
}

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: Array<{
    message: SDKUserMessage
    accept: () => void
    reject: (error: Error) => void
  }> = []
  private readonly waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  offer(message: SDKUserMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Claude chat is closed'))
    return new Promise<void>((accept, reject) => {
      const waiter = this.waiting.shift()
      if (waiter) {
        waiter({ done: false, value: message })
        accept()
      } else {
        this.queued.push({ message, accept, reject })
      }
    })
  }

  close(error = new Error('Claude chat is closed')): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.queued.splice(0)) item.reject(error)
    for (const resolve of this.waiting.splice(0)) resolve({ done: true, value: undefined })
  }

  cancelPending(error: Error): void {
    for (const item of this.queued.splice(0)) item.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const item = this.queued.shift()
        if (item) {
          item.accept()
          return { done: false, value: item.message }
        }
        if (this.closed) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiting.push(resolve))
      },
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function checkedEffort(effort: string | undefined): Options['effort'] {
  if (effort === undefined) return undefined
  if (!CLAUDE_EFFORTS.has(effort)) throw new Error(`Unsupported Claude effort: ${effort}`)
  return effort as Options['effort']
}

function sniffImageMediaType(bytes: Uint8Array): ClaudeImageMediaType | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('ascii')
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

const loadClaudeImage: ClaudeImageLoader = async (path) => {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`Claude image is not a file: ${path}`)
  if (metadata.size > MAX_CLAUDE_IMAGE_BYTES) throw new Error(`Claude image exceeds 3.75 MB: ${path}`)
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_CLAUDE_IMAGE_BYTES) throw new Error(`Claude image exceeds 3.75 MB: ${path}`)
  const mediaType = sniffImageMediaType(bytes)
  if (!mediaType) throw new Error(`Unsupported Claude image type: ${path}`)
  return { mediaType, bytes }
}

function dataUrlImageBlock(image: string): Record<string, unknown> {
  const match = /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(image)
  if (!match) throw new Error('Invalid Claude image data URL')
  const data = match[2].replace(/\s/g, '')
  if (Buffer.byteLength(data, 'base64') > MAX_CLAUDE_IMAGE_BYTES) {
    throw new Error('Claude image exceeds 3.75 MB')
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: match[1], data },
  }
}

async function userMessage(
  text: string,
  images: string[],
  loadImage: ClaudeImageLoader,
): Promise<{ sdk: SDKUserMessage; chat: ChatMessage }> {
  if (images.length > MAX_CLAUDE_IMAGES) throw new Error(`Claude supports at most ${MAX_CLAUDE_IMAGES} attached images`)
  const uid = crypto.randomUUID()
  const sdkContent: Array<Record<string, unknown>> = []
  for (const image of images) {
    if (image.startsWith('data:')) {
      sdkContent.push(dataUrlImageBlock(image))
      continue
    }
    const loaded = await loadImage(image)
    if (loaded.bytes.byteLength > MAX_CLAUDE_IMAGE_BYTES) throw new Error(`Claude image exceeds 3.75 MB: ${image}`)
    sdkContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: loaded.mediaType,
        data: Buffer.from(loaded.bytes).toString('base64'),
      },
    })
  }
  const chatBlocks: ChatMessage['blocks'] = images.map(() => ({ kind: 'image', alt: 'Attached image' }))
  if (text) {
    sdkContent.push({ type: 'text', text })
    chatBlocks.push({ kind: 'text', text })
  }
  return {
    sdk: {
      type: 'user',
      parent_tool_use_id: null,
      uuid: uid,
      message: { role: 'user', content: sdkContent as unknown as SDKUserMessage['message']['content'] },
    },
    chat: { uid, role: 'user', blocks: chatBlocks, ts: Date.now() },
  }
}

function historicalChatMessages(messages: SessionMessage[]): ChatMessage[] {
  const history: ChatMessage[] = []
  const byUid = new Map<string, number>()
  for (const sessionMessage of messages) {
    for (const parsed of parseClaudeLine(JSON.stringify(sessionMessage))) {
      const innerMessage = sessionMessage.message && typeof sessionMessage.message === 'object'
        ? sessionMessage.message as Record<string, unknown>
        : null
      const uid = sessionMessage.type === 'assistant' && typeof innerMessage?.id === 'string'
        ? innerMessage.id
        : parsed.uid
      const existingIndex = byUid.get(uid)
      if (existingIndex !== undefined) {
        const existing = history[existingIndex]
        if (existing && existing.role === parsed.role) {
          existing.blocks = [...existing.blocks, ...parsed.blocks].slice(0, MAX_BLOCKS_PER_MESSAGE)
          continue
        }
      }
      byUid.set(uid, history.length)
      history.push({ ...parsed, uid })
    }
  }
  return history.slice(-MAX_CLAUDE_HISTORY_MESSAGES)
}

export function createClaudeAdapter(
  emit: ProviderEventSink,
  createQuery: ClaudeQueryFactory = (input) => query(input),
  loadImage: ClaudeImageLoader = loadClaudeImage,
  loadSessionMessages: ClaudeSessionMessageLoader = (sessionId, options) => getSessionMessages(sessionId, options),
  resolveClaudeExecutable: ClaudeExecutableResolver = resolvePackagedClaudeExecutable,
): NativeChatAdapter {
  let runtime: ClaudeQueryLike | null = null
  let promptQueue: PromptQueue | null = null
  let streamTask: Promise<void> | null = null
  let closed = false
  let failed = false
  let status: NativeChatStatus = 'stopped'
  let inputGeneration = 0
  let currentSettings: NativeChatSettings = {}
  let rejectStartup: ((error: Error) => void) | null = null
  type PendingRequest = {
    request: NativeChatRequest
    input: Record<string, unknown>
    resolve: (result: PermissionResult) => void
    reject: (error: Error) => void
    signal: AbortSignal
    onAbort: () => void
  }
  const pendingRequests = new Map<string, PendingRequest>()
  const assistantStreams = new Map<string, {
    blocks: Array<ChatBlock | undefined>
    partialToolJson: Map<number, string>
    completedBlocks: number
  }>()
  const activeAssistantByParent = new Map<string, string>()

  const setStatus = (next: NativeChatStatus, error?: string): void => {
    status = next
    emit({ kind: 'status', status: next, ...(error ? { error } : {}) })
  }

  const emitAssistant = (uid: string): void => {
    const state = assistantStreams.get(uid)
    if (!state) return
    const blocks = state.blocks.filter((block): block is ChatBlock => block !== undefined)
      .map((block): ChatBlock => {
        if (block.kind === 'text') {
          return { ...block, text: truncateMiddle(block.text, TEXT_CAP, 4_000, 1_500) }
        }
        if (block.kind === 'thinking') {
          return { ...block, text: truncateMiddle(block.text, THINKING_CAP, 1_400, 400) }
        }
        return { ...block }
      })
    if (blocks.length > 0) emit({ kind: 'messages', messages: [{ uid, role: 'assistant', blocks }] })
  }

  const handleStreamEvent = (message: Extract<SDKMessage, { type: 'stream_event' }>): void => {
    const event = message.event as unknown as Record<string, unknown>
    const parentKey = message.parent_tool_use_id ?? ''
    if (event.type === 'message_start') {
      const sdkMessage = event.message as { id?: unknown } | undefined
      const uid = typeof sdkMessage?.id === 'string' ? sdkMessage.id : message.uuid
      activeAssistantByParent.set(parentKey, uid)
      assistantStreams.set(uid, { blocks: [], partialToolJson: new Map(), completedBlocks: 0 })
      return
    }
    const uid = activeAssistantByParent.get(parentKey) ?? message.uuid
    let state = assistantStreams.get(uid)
    if (!state) {
      state = { blocks: [], partialToolJson: new Map(), completedBlocks: 0 }
      assistantStreams.set(uid, state)
      activeAssistantByParent.set(parentKey, uid)
    }
    const index = typeof event.index === 'number' ? event.index : 0
    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'text') {
        state.blocks[index] = { kind: 'text', text: typeof block.text === 'string' ? block.text : '' }
      } else if (block?.type === 'thinking') {
        state.blocks[index] = { kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : '' }
      } else if (block?.type === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? block.input : {}
        state.blocks[index] = {
          kind: 'tool',
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
          name: typeof block.name === 'string' ? block.name : 'Tool',
          input: summarizeToolInput(typeof block.name === 'string' ? block.name : 'Tool', input),
        }
        state.partialToolJson.set(index, '')
      }
      emitAssistant(uid)
      return
    }
    if (event.type !== 'content_block_delta') return
    const delta = event.delta as Record<string, unknown> | undefined
    const block = state.blocks[index]
    if (delta?.type === 'text_delta' && block?.kind === 'text' && typeof delta.text === 'string') {
      state.blocks[index] = { ...block, text: block.text + delta.text }
    } else if (delta?.type === 'thinking_delta' && block?.kind === 'thinking' && typeof delta.thinking === 'string') {
      state.blocks[index] = { ...block, text: block.text + delta.thinking }
    } else if (delta?.type === 'input_json_delta' && block?.kind === 'tool' && typeof delta.partial_json === 'string') {
      const json = (state.partialToolJson.get(index) ?? '') + delta.partial_json
      state.partialToolJson.set(index, json)
      try {
        state.blocks[index] = { ...block, input: summarizeToolInput(block.name, JSON.parse(json)) }
      } catch {
        state.blocks[index] = { ...block, input: json }
      }
    }
    emitAssistant(uid)
  }

  const toAssistantBlock = (raw: unknown): ChatBlock | null => {
    if (!raw || typeof raw !== 'object') return null
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      return { kind: 'text', text: block.text }
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return { kind: 'thinking', text: block.thinking }
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool'
      return {
        kind: 'tool',
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        name,
        input: summarizeToolInput(name, block.input),
      }
    }
    return null
  }

  const handleAssistant = (message: Extract<SDKMessage, { type: 'assistant' }>): void => {
    const uid = message.message.id
    let state = assistantStreams.get(uid)
    if (!state) {
      state = { blocks: [], partialToolJson: new Map(), completedBlocks: 0 }
      assistantStreams.set(uid, state)
    }
    for (const raw of message.message.content) {
      const block = toAssistantBlock(raw)
      if (!block) continue
      state.blocks[state.completedBlocks] = block
      state.completedBlocks += 1
    }
    activeAssistantByParent.set(message.parent_tool_use_id ?? '', uid)
    emitAssistant(uid)
  }

  const toolResultText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text
        try { return JSON.stringify(item) }
        catch { return String(item) }
      }).join('\n')
    }
    try { return JSON.stringify(content) ?? '' }
    catch { return String(content) }
  }

  const handleToolResults = (message: Extract<SDKMessage, { type: 'user' }>): void => {
    const content = message.message.content
    if (!Array.isArray(content)) return
    const blocks: ChatBlock[] = []
    for (const raw of content) {
      const block = raw as unknown as Record<string, unknown>
      if (block.type !== 'tool_result') continue
      blocks.push({
        kind: 'toolResult',
        ...(typeof block.tool_use_id === 'string' ? { forId: block.tool_use_id } : {}),
        output: truncateMiddle(toolResultText(block.content), TOOL_RESULT_CAP, 1_700, 600),
        ...(block.is_error === true ? { isError: true } : {}),
      })
    }
    if (blocks.length > 0) {
      const firstToolId = blocks[0]?.kind === 'toolResult' ? blocks[0].forId : undefined
      emit({
        kind: 'messages',
        messages: [{ uid: message.uuid ?? `tool-result:${firstToolId ?? crypto.randomUUID()}`, role: 'tool', blocks }],
      })
    }
  }

  const handleMessage = (message: SDKMessage): void => {
    if (message.type === 'system' && message.subtype === 'init') {
      emit({ kind: 'conversation', conversationId: message.session_id })
      return
    }
    if (message.type === 'stream_event') handleStreamEvent(message)
    else if (message.type === 'assistant') handleAssistant(message)
    else if (message.type === 'user') handleToolResults(message)
    else if (message.type === 'result') {
      if (message.subtype !== 'success' || message.is_error) {
        const detail = 'errors' in message && Array.isArray(message.errors)
          ? message.errors.join('\n')
          : 'Claude turn failed'
        setStatus('error', detail)
      } else {
        setStatus('idle')
      }
      assistantStreams.clear()
      activeAssistantByParent.clear()
    }
  }

  const finishRequest = (pending: PendingRequest): void => {
    pending.signal.removeEventListener('abort', pending.onAbort)
    pendingRequests.delete(pending.request.id)
    emit({ kind: 'request-resolved', requestId: pending.request.id })
    setStatus(pendingRequests.size > 0 ? 'waiting' : 'working')
  }

  const rejectPendingRequests = (error: Error): void => {
    for (const pending of pendingRequests.values()) {
      finishRequest(pending)
      pending.reject(error)
    }
  }

  const questionRequest = (
    requestId: string,
    input: Record<string, unknown>,
  ): NativeChatRequest => {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : []
    const questions = rawQuestions.map((raw, index) => {
      const question = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const text = typeof question.question === 'string' && question.question.length > 0
        ? question.question
        : `Question ${index + 1}`
      const options = Array.isArray(question.options) ? question.options.flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== 'object') return []
        const option = rawOption as Record<string, unknown>
        if (typeof option.label !== 'string') return []
        return [{
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        }]
      }) : []
      return {
        id: text,
        question: text,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      }
    })
    const first = rawQuestions[0]
    const title = first && typeof first === 'object' && typeof (first as Record<string, unknown>).header === 'string'
      ? (first as Record<string, unknown>).header as string
      : 'Claude has a question'
    return { id: requestId, kind: 'question', title, questions }
  }

  const canUseTool: CanUseTool = (toolName, input, options) => {
    if (closed) return Promise.reject(new Error('Claude chat is closed'))
    let requestId = options.requestId || crypto.randomUUID()
    while (pendingRequests.has(requestId)) requestId = crypto.randomUUID()
    const request: NativeChatRequest = toolName === 'AskUserQuestion'
      ? questionRequest(requestId, input)
      : {
          id: requestId,
          kind: 'approval',
          title: options.title ?? options.displayName ?? `${toolName} needs approval`,
          detail: options.description ?? summarizeToolInput(toolName, input),
        }
    return new Promise<PermissionResult>((resolve, reject) => {
      const pending = {} as PendingRequest
      const onAbort = () => {
        if (!pendingRequests.has(requestId)) return
        finishRequest(pending)
        reject(new Error('Claude request aborted'))
      }
      Object.assign(pending, { request, input, resolve, reject, signal: options.signal, onAbort })
      pendingRequests.set(requestId, pending)
      setStatus('waiting')
      emit({ kind: 'request', request })
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) onAbort()
    })
  }

  const open = async (options: ProviderOpenOptions): Promise<void> => {
    if (runtime) throw new Error('Claude chat is already open')
    if (closed) throw new Error('Claude chat is closed')
    const effort = checkedEffort(options.settings.effort)
    setStatus('starting')
    currentSettings = { ...options.settings }
    promptQueue = new PromptQueue()
    const startupFailure = new Promise<never>((_resolve, reject) => { rejectStartup = reject })
    const executable = resolveClaudeExecutable()
    runtime = createQuery({
      prompt: promptQueue,
      options: {
        cwd: options.cwd,
        ...(options.conversationId ? { resume: options.conversationId } : {}),
        ...(options.settings.model ? { model: options.settings.model } : {}),
        ...(effort ? { effort } : {}),
        includePartialMessages: true,
        permissionMode: 'default',
        settingSources: ['user', 'project', 'local'],
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        canUseTool,
      },
    })
    streamTask = (async () => {
      let failure: Error | null = null
      try {
        for await (const message of runtime!) handleMessage(message)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(errorMessage(error))
      } finally {
        if (!closed && !failed) {
          failed = true
          const disconnected = failure ?? new Error('Claude SDK stream disconnected')
          inputGeneration += 1
          rejectStartup?.(disconnected)
          rejectStartup = null
          promptQueue?.close(disconnected)
          rejectPendingRequests(disconnected)
          setStatus('error', disconnected.message)
        }
      }
    })()
    try {
      const history = options.conversationId
        ? loadSessionMessages(options.conversationId, { dir: options.cwd })
        : Promise.resolve([])
      const [initialization, sessionMessages] = await Promise.race([
        Promise.all([runtime.initializationResult(), history]),
        startupFailure,
      ])
      rejectStartup = null
      emit({
        kind: 'catalog',
        models: initialization.models.map((model) => ({
          id: model.value,
          label: model.displayName,
          efforts: [...(model.supportedEffortLevels ?? [])],
        })),
      })
      const chatHistory = historicalChatMessages(sessionMessages)
      if (chatHistory.length > 0) emit({ kind: 'messages', messages: chatHistory })
      setStatus('idle')
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(errorMessage(error))
      rejectStartup = null
      if (!failed) {
        failed = true
        inputGeneration += 1
        promptQueue.close(startupError)
        rejectPendingRequests(startupError)
        runtime.close()
        setStatus('error', startupError.message)
      }
      await streamTask
      throw startupError
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    inputGeneration += 1
    const error = new Error('Claude chat closed')
    rejectStartup?.(error)
    rejectStartup = null
    rejectPendingRequests(error)
    promptQueue?.close()
    runtime?.close()
    await streamTask
    setStatus('stopped')
  }

  const requireRuntime = (): { runtime: ClaudeQueryLike; queue: PromptQueue } => {
    if (!runtime || !promptQueue) throw new Error('Claude chat is not open')
    if (closed) throw new Error('Claude chat is closed')
    if (failed) throw new Error('Claude chat is unavailable')
    return { runtime, queue: promptQueue }
  }

  const configure: NativeChatAdapter['configure'] = async (settings) => {
    const active = requireRuntime()
    if (status !== 'idle') throw new Error('Claude model and effort can only be changed while idle')
    const effort = checkedEffort(settings.effort)
    const previous = currentSettings
    const changesModel = settings.model !== previous.model
    const changesEffort = settings.effort !== previous.effort
    let modelApplied = false
    let effortApplied = false
    try {
      if (changesModel) {
        await active.runtime.setModel(settings.model)
        modelApplied = true
      }
      if (changesEffort) {
        await active.runtime.applyFlagSettings({ effortLevel: effort ?? null })
        effortApplied = true
      }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (effortApplied) {
        try {
          await active.runtime.applyFlagSettings({ effortLevel: checkedEffort(previous.effort) ?? null })
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (modelApplied) {
        try {
          await active.runtime.setModel(previous.model)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        const fatal = new Error(
          `${errorMessage(error)}; Claude configuration rollback failed: ${rollbackErrors.map(errorMessage).join('; ')}`,
        )
        active.queue.close(fatal)
        failed = true
        active.runtime.close()
        setStatus('error', fatal.message)
        throw fatal
      }
      throw error
    }
    currentSettings = { ...settings }
  }

  const send: NativeChatAdapter['send'] = async (input) => {
    const active = requireRuntime()
    if (!input.text && input.images.length === 0) throw new Error('Claude turn input is empty')
    const generation = inputGeneration
    const checkActive = (): void => {
      if (generation !== inputGeneration || closed) throw new Error('Claude send interrupted')
    }
    if (input.settings.model !== currentSettings.model || input.settings.effort !== currentSettings.effort) {
      await configure(input.settings)
      checkActive()
    }
    const message = await userMessage(input.text, input.images, loadImage)
    checkActive()
    await active.queue.offer(message.sdk)
    emit({ kind: 'messages', messages: [message.chat] })
    setStatus('working')
  }

  const compact: NativeChatAdapter['compact'] = async () => {
    const active = requireRuntime()
    if (status !== 'idle') throw new Error('Claude can only compact while idle')
    const generation = inputGeneration
    setStatus('compacting')
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
    }
    try {
      await active.queue.offer(message)
    } catch (error) {
      if (generation !== inputGeneration || closed) throw error
      setStatus('error', errorMessage(error))
      throw error
    }
  }

  const interrupt: NativeChatAdapter['interrupt'] = async () => {
    const active = requireRuntime()
    inputGeneration += 1
    active.queue.cancelPending(new Error('Claude turn interrupted'))
    rejectPendingRequests(new Error('Claude turn interrupted'))
    await active.runtime.interrupt()
    setStatus('idle')
  }

  const respond: NativeChatAdapter['respond'] = async (reply) => {
    const pending = pendingRequests.get(reply.requestId)
    if (!pending) throw new Error(`Unknown Claude request: ${reply.requestId}`)
    let result: PermissionResult
    if (pending.request.kind === 'question') {
      if (!reply.answers) throw new Error('Claude question response requires answers')
      const answers = Object.fromEntries(
        Object.entries(reply.answers).map(([question, values]) => [question, values.join(', ')]),
      )
      result = {
        behavior: 'allow',
        updatedInput: { questions: pending.input.questions, answers },
      }
    } else if (reply.decision === 'allow') {
      result = { behavior: 'allow', updatedInput: pending.input }
    } else if (reply.decision === 'deny') {
      result = { behavior: 'deny', message: 'User declined tool execution.' }
    } else {
      throw new Error('Claude approval response requires an allow or deny decision')
    }
    finishRequest(pending)
    pending.resolve(result)
  }

  return {
    open,
    send,
    configure,
    compact,
    interrupt,
    respond,
    close,
  }
}
