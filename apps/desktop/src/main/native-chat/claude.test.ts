import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  createClaudeAdapter,
  resolvePackagedClaudeExecutable,
  type ClaudeImageLoader,
  type ClaudeQueryFactory,
  type ClaudeQueryLike,
  type ClaudeSessionMessageLoader,
} from './claude'
import type { ProviderEvent } from './provider'

class OutputQueue implements AsyncIterable<SDKMessage> {
  private readonly values: SDKMessage[] = []
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = []
  private ended = false

  push(value: SDKMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }

  close(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

class FakeQuery extends OutputQueue implements ClaudeQueryLike {
  interruptCalls = 0
  readonly models: Array<string | undefined> = []
  initializationModels: SDKControlInitializeResponse['models'] = []
  readonly flagSettings: unknown[] = []
  setModelError: Error | undefined
  flagSettingsError: Error | undefined

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return { models: this.initializationModels } as SDKControlInitializeResponse
  }
  async interrupt(): Promise<undefined> { this.interruptCalls += 1; return undefined }
  async setModel(model?: string): Promise<void> {
    this.models.push(model)
    if (this.setModelError) throw this.setModelError
  }
  async applyFlagSettings(settings: unknown): Promise<void> {
    this.flagSettings.push(settings)
    if (this.flagSettingsError) throw this.flagSettingsError
  }
  override close(): void { super.close() }
}

function initMessage(sessionId = 'claude-session') {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    uuid: '00000000-0000-4000-8000-000000000001',
    apiKeySource: 'none',
    claude_code_version: '2.1.260',
    cwd: '/work',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-6',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  } satisfies SDKMessage
}

const sdkMessage = (value: unknown): SDKMessage => value as SDKMessage
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function setup(loadImage?: ClaudeImageLoader, loadSessionMessages?: ClaudeSessionMessageLoader) {
  const output = new FakeQuery()
  const events: ProviderEvent[] = []
  let prompt!: AsyncIterable<SDKUserMessage>
  let options!: Parameters<ClaudeQueryFactory>[0]['options']
  const createQuery: ClaudeQueryFactory = (input) => {
    prompt = input.prompt
    options = input.options
    return output
  }
  const historyLoader = loadSessionMessages ?? (async () => [])
  const adapter = createClaudeAdapter(
    (event) => events.push(event),
    createQuery,
    loadImage,
    historyLoader,
    () => '/packaged/claude',
  )
  return { adapter, events, output, get prompt() { return prompt }, get options() { return options } }
}

describe('createClaudeAdapter', () => {
  it('opens a resumable streaming SDK query with default permissions', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({
      cwd: '/work',
      conversationId: 'resume-me',
      settings: { model: 'claude-sonnet-4-6', effort: 'high' },
    })
    fixture.output.push(initMessage('resume-me'))
    await opening

    expect(fixture.options).toMatchObject({
      cwd: '/work',
      resume: 'resume-me',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: '/packaged/claude',
    })
    expect(fixture.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(fixture.options.canUseTool).toBeTypeOf('function')
    expect(fixture.events).toContainEqual({ kind: 'conversation', conversationId: 'resume-me' })
    expect(fixture.events).toContainEqual({ kind: 'status', status: 'idle' })

    await fixture.adapter.close()
  })

  it('resolves the native CLI from electron-builder app.asar.unpacked resources', () => {
    const expected = '/Applications/Orchestra.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    expect(resolvePackagedClaudeExecutable(
      '/Applications/Orchestra.app/Contents/Resources',
      'darwin',
      'arm64',
      (path) => path === expected,
    )).toBe(expected)
    expect(resolvePackagedClaudeExecutable('/missing', 'darwin', 'arm64', () => false)).toBeUndefined()
  })

  it('finishes opening after the SDK handshake without waiting for a prompt event', async () => {
    const fixture = setup()
    fixture.output.initializationModels = [{
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Fast and capable',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    }]
    await fixture.adapter.open({ cwd: '/work', settings: {} })

    expect(fixture.events).toEqual([
      { kind: 'status', status: 'starting' },
      {
        kind: 'catalog',
        models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }],
      },
      { kind: 'status', status: 'idle' },
    ])

    fixture.output.push(initMessage('first-turn-session'))
    await flush()
    expect(fixture.events.at(-1)).toEqual({ kind: 'conversation', conversationId: 'first-turn-session' })
    await fixture.adapter.close()
  })

  it('loads and bounds history for the exact resumed session and directory', async () => {
    const calls: Array<{ sessionId: string; options: unknown }> = []
    const loadHistory: ClaudeSessionMessageLoader = async (sessionId, options) => {
      calls.push({ sessionId, options })
      const messages: SessionMessage[] = Array.from({ length: 401 }, (_, index) => ({
        type: 'user' as const,
        uuid: `user-${index}`,
        session_id: sessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'text', text: `Prompt ${index}` }] },
      }))
      messages.splice(399, 0,
        {
          type: 'assistant',
          uuid: 'assistant-record-1',
          session_id: sessionId,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { id: 'assistant-message', role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }] },
        },
        {
          type: 'assistant',
          uuid: 'assistant-record-2',
          session_id: sessionId,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { id: 'assistant-message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        },
      )
      return messages
    }
    const fixture = setup(undefined, loadHistory)
    await fixture.adapter.open({ cwd: '/work', conversationId: 'resume-exact', settings: {} })

    expect(calls).toEqual([{ sessionId: 'resume-exact', options: { dir: '/work' } }])
    const historyEvent = fixture.events.find((event) => event.kind === 'messages')
    if (!historyEvent || historyEvent.kind !== 'messages') throw new Error('missing history')
    expect(historyEvent.messages).toHaveLength(400)
    expect(historyEvent.messages[0]?.uid).toBe('user-2')
    expect(historyEvent.messages).toContainEqual({
      uid: 'assistant-message',
      role: 'assistant',
      blocks: [{ kind: 'thinking', text: 'plan' }, { kind: 'text', text: 'answer' }],
    })
    await fixture.adapter.close()
  })

  it('acknowledges sends when the SDK consumes them and preserves text and images', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening

    let accepted = false
    const sending = fixture.adapter.send({
      text: 'Inspect this',
      images: ['data:image/png;base64,aGk='],
      settings: {},
    }).then(() => { accepted = true })
    await Promise.resolve()
    expect(accepted).toBe(false)

    const delivered = await fixture.prompt[Symbol.asyncIterator]().next()
    await sending
    expect(delivered.done).toBe(false)
    expect(delivered.value?.message).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        { type: 'text', text: 'Inspect this' },
      ],
    })
    expect(delivered.value?.uuid).toBeTypeOf('string')
    expect(fixture.events.at(-2)).toMatchObject({
      kind: 'messages',
      messages: [{ role: 'user', blocks: [{ kind: 'image', alt: 'Attached image' }, { kind: 'text', text: 'Inspect this' }] }],
    })
    expect(fixture.events.at(-1)).toEqual({ kind: 'status', status: 'working' })

    await fixture.adapter.close()
  })

  it('rejects an empty turn before it reaches the SDK input stream', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    await expect(fixture.adapter.send({ text: '', images: [], settings: {} }))
      .rejects.toThrow(/empty/i)
    await fixture.adapter.close()
  })

  it('reads local image paths before offering them to the SDK', async () => {
    const paths: string[] = []
    const fixture = setup(async (path) => {
      paths.push(path)
      return { mediaType: 'image/png', bytes: new Uint8Array([104, 105]) }
    })
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening

    const sending = fixture.adapter.send({ text: '', images: ['/tmp/screenshot.png'], settings: {} })
    const delivered = await fixture.prompt[Symbol.asyncIterator]().next()
    await sending
    expect(paths).toEqual(['/tmp/screenshot.png'])
    expect(delivered.value?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ])
    await fixture.adapter.close()
  })

  it('does not enqueue a send interrupted during an image read', async () => {
    const started = deferred()
    const release = deferred()
    const fixture = setup(async () => {
      started.resolve()
      await release.promise
      return { mediaType: 'image/png', bytes: new Uint8Array([104, 105]) }
    })
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening

    const sending = fixture.adapter.send({ text: 'late', images: ['/tmp/slow.png'], settings: {} })
    const rejected = expect(sending).rejects.toThrow(/interrupted/i)
    await started.promise
    await fixture.adapter.interrupt()
    release.resolve()
    await rejected
    expect(fixture.events.some((event) => event.kind === 'messages')).toBe(false)
    await fixture.adapter.close()
  })

  it('rejects unsupported, oversized, and excessive local images before enqueue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orchestra-claude-images-'))
    try {
      const unsupported = join(directory, 'unsupported.bin')
      const oversized = join(directory, 'oversized.png')
      await writeFile(unsupported, new Uint8Array([1, 2, 3]))
      await writeFile(oversized, new Uint8Array(3_750_001))
      const fixture = setup()
      const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
      fixture.output.push(initMessage())
      await opening

      await expect(fixture.adapter.send({ text: '', images: [unsupported], settings: {} }))
        .rejects.toThrow(/unsupported/i)
      await expect(fixture.adapter.send({ text: '', images: [oversized], settings: {} }))
        .rejects.toThrow(/3\.75 MB/i)
      await expect(fixture.adapter.send({ text: '', images: ['a', 'b', 'c', 'd', 'e'], settings: {} }))
        .rejects.toThrow(/at most 4/i)
      expect(fixture.events.some((event) => event.kind === 'messages')).toBe(false)
      await fixture.adapter.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('upserts stable assistant snapshots while thinking, text, and tool calls stream', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening

    const stream = (event: unknown, uuid: string) => fixture.output.push(sdkMessage({
      type: 'stream_event', event, uuid, session_id: 'claude-session', parent_tool_use_id: null,
    }))
    stream({ type: 'message_start', message: { id: 'assistant-1' } }, 'stream-1')
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'stream-2')
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }, 'stream-3')
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'stream-4')
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } }, 'stream-5')
    stream({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
    }, 'stream-6')
    stream({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' },
    }, 'stream-7')
    await flush()

    const snapshots = fixture.events.filter((event) => event.kind === 'messages')
    expect(snapshots.at(-1)).toEqual({
      kind: 'messages',
      messages: [{
        uid: 'assistant-1',
        role: 'assistant',
        blocks: [
          { kind: 'thinking', text: 'plan' },
          { kind: 'text', text: 'Hello' },
          { kind: 'tool', id: 'tool-1', name: 'Bash', input: 'npm test' },
        ],
      }],
    })
    expect(snapshots.every((event) => event.messages[0]?.uid === 'assistant-1')).toBe(true)

    fixture.output.push(sdkMessage({
      type: 'user',
      uuid: 'tool-result-1',
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'passed' }],
      },
    }))
    await flush()
    expect(fixture.events.at(-1)).toEqual({
      kind: 'messages',
      messages: [{
        uid: 'tool-result-1',
        role: 'tool',
        blocks: [{ kind: 'toolResult', forId: 'tool-1', output: 'passed' }],
      }],
    })

    await fixture.adapter.close()
  })

  it('merges completed assistant blocks when partial events are unavailable', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const assistant = (uuid: string, content: unknown[]) => fixture.output.push(sdkMessage({
      type: 'assistant',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { id: 'complete-1', role: 'assistant', content },
    }))

    assistant('assistant-thinking', [{ type: 'thinking', thinking: 'consider' }])
    assistant('assistant-text', [{ type: 'text', text: 'Done' }])
    assistant('assistant-tool', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } }])
    await flush()

    const messages = fixture.events.filter((event) => event.kind === 'messages')
    expect(messages.at(-1)).toEqual({
      kind: 'messages',
      messages: [{
        uid: 'complete-1',
        role: 'assistant',
        blocks: [
          { kind: 'thinking', text: 'consider' },
          { kind: 'text', text: 'Done' },
          { kind: 'tool', id: 'read-1', name: 'Read', input: 'a.ts' },
        ],
      }],
    })
    expect(messages.slice(-3).every((event) => event.messages[0]?.uid === 'complete-1')).toBe(true)
    await fixture.adapter.close()
  })

  it('keeps interleaved root and subagent streams on their own stable messages', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const stream = (parent: string | null, event: unknown, uuid: string) => fixture.output.push(sdkMessage({
      type: 'stream_event', event, uuid, session_id: 'claude-session', parent_tool_use_id: parent,
    }))
    stream(null, { type: 'message_start', message: { id: 'root-message' } }, 'root-start')
    stream(null, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'root-block')
    stream('agent-tool', { type: 'message_start', message: { id: 'sub-message' } }, 'sub-start')
    stream('agent-tool', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'sub-block')
    stream('agent-tool', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sub' } }, 'sub-delta')
    stream(null, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Root' } }, 'root-delta')
    await flush()

    const messageEvents = fixture.events.filter((event) => event.kind === 'messages')
    expect(messageEvents.at(-1)).toEqual({
      kind: 'messages',
      messages: [{ uid: 'root-message', role: 'assistant', blocks: [{ kind: 'text', text: 'Root' }] }],
    })
    expect(messageEvents).toContainEqual({
      kind: 'messages',
      messages: [{ uid: 'sub-message', role: 'assistant', blocks: [{ kind: 'text', text: 'Sub' }] }],
    })
    await fixture.adapter.close()
  })

  it('bounds streamed text while preserving the newest tail', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const stream = (event: unknown, uuid: string) => fixture.output.push(sdkMessage({
      type: 'stream_event', event, uuid, session_id: 'claude-session', parent_tool_use_id: null,
    }))
    stream({ type: 'message_start', message: { id: 'long-message' } }, 'long-start')
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'long-block')
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a'.repeat(7_000) } }, 'long-a')
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'THE END' } }, 'long-end')
    await flush()

    const event = fixture.events.findLast((candidate) => candidate.kind === 'messages')
    if (!event || event.kind !== 'messages') throw new Error('missing streamed message')
    const block = event.messages[0]?.blocks[0]
    expect(block?.kind).toBe('text')
    expect(block && 'text' in block ? block.text.length : 0).toBeLessThanOrEqual(6_000)
    expect(block && 'text' in block ? block.text : '').toMatch(/THE END$/)
    await fixture.adapter.close()
  })

  it('applies model and effort controls while idle and rejects mid-turn changes', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({
      cwd: '/work',
      settings: { model: 'claude-sonnet-4-6', effort: 'medium' },
    })
    fixture.output.push(initMessage())
    await opening

    await fixture.adapter.configure({ model: 'claude-opus-4-6', effort: 'max' })
    expect(fixture.output.models).toEqual(['claude-opus-4-6'])
    expect(fixture.output.flagSettings).toEqual([{ effortLevel: 'max' }])

    const sending = fixture.adapter.send({
      text: 'Continue', images: [], settings: { model: 'claude-opus-4-6', effort: 'max' },
    })
    await fixture.prompt[Symbol.asyncIterator]().next()
    await sending
    await expect(fixture.adapter.configure({ model: 'claude-haiku-4-5', effort: 'low' }))
      .rejects.toThrow(/idle/i)

    await fixture.adapter.interrupt()
    expect(fixture.output.interruptCalls).toBe(1)
    expect(fixture.events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
    await expect(fixture.adapter.configure({ effort: 'ultra' })).rejects.toThrow(/unsupported/i)

    await fixture.adapter.close()
  })

  it('rolls back the model when an effort update fails', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({
      cwd: '/work', settings: { model: 'claude-sonnet-4-6', effort: 'medium' },
    })
    fixture.output.push(initMessage())
    await opening
    fixture.output.flagSettingsError = new Error('effort rejected')

    await expect(fixture.adapter.configure({ model: 'claude-opus-4-6', effort: 'high' }))
      .rejects.toThrow('effort rejected')
    expect(fixture.output.models).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6'])
    fixture.output.flagSettingsError = undefined
    await fixture.adapter.configure({ model: 'claude-sonnet-4-6', effort: 'medium' })
    expect(fixture.output.models).toHaveLength(2)
    expect(fixture.output.flagSettings).toHaveLength(1)

    await fixture.adapter.close()
  })

  it('sends compact through the SDK stream without adding a visible user message', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const before = fixture.events.length

    const compacting = fixture.adapter.compact()
    expect(fixture.events.at(-1)).toEqual({ kind: 'status', status: 'compacting' })
    const delivered = await fixture.prompt[Symbol.asyncIterator]().next()
    await compacting
    expect(delivered.value?.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '/compact' }],
    })
    expect(fixture.events.slice(before).some((event) => event.kind === 'messages')).toBe(false)

    fixture.output.push(sdkMessage({
      type: 'result', subtype: 'success', session_id: 'claude-session', uuid: 'result-1', is_error: false,
    }))
    await flush()
    expect(fixture.events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
    await fixture.adapter.close()
  })

  it('interrupts a compact still waiting for SDK acceptance without a late error status', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const before = fixture.events.length
    const compacting = fixture.adapter.compact()
    const rejected = expect(compacting).rejects.toThrow(/interrupted/i)
    await Promise.resolve()

    await fixture.adapter.interrupt()
    await rejected
    expect(fixture.events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
    expect(fixture.events.slice(before).some((event) => event.kind === 'status' && event.status === 'error')).toBe(false)
    await fixture.adapter.close()
  })

  it('bridges tool approvals and AskUserQuestion through native requests', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const canUseTool = fixture.options.canUseTool!

    const approval = canUseTool('Bash', { command: 'npm test' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-approval',
      requestId: 'approval-request',
    })
    await flush()
    const approvalEvent = fixture.events.at(-1)
    expect(approvalEvent).toMatchObject({
      kind: 'request',
      request: { id: 'approval-request', kind: 'approval', detail: 'npm test' },
    })
    if (approvalEvent?.kind !== 'request') throw new Error('missing approval request')
    await fixture.adapter.respond({ requestId: approvalEvent.request.id, decision: 'allow' })
    await expect(approval).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
    expect(fixture.events.slice(-2)).toEqual([
      { kind: 'request-resolved', requestId: 'approval-request' },
      { kind: 'status', status: 'working' },
    ])

    const questionInput = {
      questions: [{
        header: 'Choose',
        question: 'Pick targets',
        options: [{ label: 'Unit' }, { label: 'Integration', description: 'Slower' }],
        multiSelect: true,
      }],
    }
    const question = canUseTool('AskUserQuestion', questionInput, {
      signal: new AbortController().signal,
      toolUseID: 'tool-question',
      requestId: 'question-request',
    })
    await flush()
    const questionEvent = fixture.events.at(-1)
    expect(questionEvent).toEqual({
      kind: 'request',
      request: {
        id: 'question-request',
        kind: 'question',
        title: 'Choose',
        questions: [{
          id: 'Pick targets',
          question: 'Pick targets',
          options: [{ label: 'Unit' }, { label: 'Integration', description: 'Slower' }],
          multiSelect: true,
        }],
      },
    })
    await fixture.adapter.respond({
      requestId: 'question-request', answers: { 'Pick targets': ['Unit', 'Integration'] },
    })
    await expect(question).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions: questionInput.questions, answers: { 'Pick targets': 'Unit, Integration' } },
    })

    await fixture.adapter.close()
  })

  it('rejects pending permission callbacks when the adapter closes', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const pending = fixture.options.canUseTool!('Write', { file_path: '/tmp/a' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-close',
      requestId: 'close-request',
    })
    const rejected = expect(pending).rejects.toThrow(/closed/i)
    await flush()
    await fixture.adapter.close()
    await rejected
  })

  it('rejects pending work when the SDK stream disconnects', async () => {
    const fixture = setup()
    const opening = fixture.adapter.open({ cwd: '/work', settings: {} })
    fixture.output.push(initMessage())
    await opening
    const permission = fixture.options.canUseTool!('Write', { file_path: '/tmp/a' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-disconnect',
      requestId: 'disconnect-request',
    })
    const permissionRejected = expect(permission).rejects.toThrow(/disconnected/i)
    const sending = fixture.adapter.send({ text: 'queued', images: [], settings: {} })
    const sendRejected = expect(sending).rejects.toThrow(/disconnected/i)
    await flush()

    fixture.output.close()
    await Promise.all([permissionRejected, sendRejected])
    expect(fixture.events.at(-1)).toEqual({
      kind: 'status', status: 'error', error: 'Claude SDK stream disconnected',
    })
    await fixture.adapter.close()
  })
})
