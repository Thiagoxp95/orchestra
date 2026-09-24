import { describe, expect, it } from 'vitest'
import type { ProviderEvent } from './provider'
import type { CodexRpcTransport, JsonRpcId, RpcNotificationHandler, RpcRequestHandler } from './codex-rpc'
import { createCursorAdapter } from './cursor'

type Call = { method: string; params: unknown }
type Reply = unknown | ((params: unknown) => unknown)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const effort = (id: string, currentValue: string, values: string[]) => ({
  id, name: 'Effort', category: 'thought_level', type: 'select', currentValue,
  options: values.map((value) => ({ value, name: value })),
})
const modelOption = (currentValue: string) => ({
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue,
  options: [{ value: 'default', name: 'Auto' }, { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { value: 'gpt-5.5', name: 'GPT-5.5' }],
})

class FakeTransport implements CodexRpcTransport {
  readonly requests: Call[] = []
  readonly notifications: Call[] = []
  readonly replies = new Map<string, Reply>()
  closed = false
  private notificationHandler: RpcNotificationHandler = () => {}
  private requestHandler: RpcRequestHandler = async () => ({})
  private disconnectHandler: (error: Error) => void = () => {}

  constructor() {
    this.replies.set('session/new', { sessionId: 'sess-new', configOptions: [modelOption('default')] })
    this.replies.set('session/load', { configOptions: [modelOption('default')] })
    this.replies.set('cursor/list_available_models', {
      models: [
        { value: 'default', name: 'Auto', configOptions: [] },
        { value: 'gpt-5.5', name: 'GPT-5.5', configOptions: [effort('reasoning', 'medium', ['none', 'low', 'medium', 'high', 'extra-high'])] },
      ],
    })
    this.replies.set('session/set_config_option', (params) => {
      const { configId, value } = params as { configId: string; value: string }
      if (configId === 'model') {
        return { configOptions: [modelOption(value), ...(value === 'gpt-5.5' ? [effort('reasoning', 'medium', ['low', 'medium', 'extra-high'])] : [])] }
      }
      return { configOptions: [modelOption('gpt-5.5'), effort('reasoning', value, ['low', 'medium', 'extra-high'])] }
    })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    const reply = this.replies.get(method)
    return typeof reply === 'function' ? reply(params) : reply ?? {}
  }

  notify(method: string, params?: unknown): void { this.notifications.push({ method, params }) }
  onNotification(handler: RpcNotificationHandler): void { this.notificationHandler = handler }
  onRequest(handler: RpcRequestHandler): void { this.requestHandler = handler }
  onDisconnect(handler: (error: Error) => void): void { this.disconnectHandler = handler }
  async close(): Promise<void> { this.closed = true }

  update(sessionId: string, update: Record<string, unknown>): void {
    this.notificationHandler('session/update', { sessionId, update })
  }

  serverRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    return this.requestHandler(method, params, id)
  }

  disconnect(message = 'agent exited'): void { this.disconnectHandler(new Error(message)) }
}

function setup() {
  const rpc = new FakeTransport()
  const events: ProviderEvent[] = []
  const imports: string[][] = []
  const adapter = createCursorAdapter((event) => events.push(event), {
    createTransport: () => rpc,
    loadImage: async () => ({ mimeType: 'image/png', data: 'AAAA' }),
    importTerminalChat: async (id, cwd) => {
      imports.push([id, cwd, String(rpc.requests.some((call) => call.method === 'session/load'))])
      return true
    },
  })
  return { rpc, events, adapter, imports }
}

const messages = (events: ProviderEvent[]) => events.flatMap((event) => event.kind === 'messages' ? event.messages : [])
const params = (rpc: FakeTransport, method: string) => rpc.requests.filter((call) => call.method === method).map((call) => call.params)
const permission = {
  sessionId: 'sess-new',
  toolCall: {
    toolCallId: 'call-1', title: '`echo hi > hello.txt`', kind: 'execute', status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: 'Not in allowlist: echo' } }],
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ],
}

describe('createCursorAdapter', () => {
  it('handshakes, creates a session, and publishes the discovered catalog', async () => {
    const { rpc, events, adapter, imports } = setup()
    await adapter.open({ cwd: '/work', settings: {} })

    expect(rpc.requests.map((call) => call.method)).toEqual([
      'initialize', 'authenticate', 'session/new', 'cursor/list_available_models',
    ])
    expect(rpc.requests[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } } })
    expect(params(rpc, 'authenticate')).toEqual([{ methodId: 'cursor_login' }])
    expect(params(rpc, 'session/new')).toEqual([{ cwd: '/work', mcpServers: [] }])
    expect(events).toContainEqual({ kind: 'conversation', conversationId: 'sess-new' })
    expect(imports).toEqual([])
    expect(events).toContainEqual({
      kind: 'catalog',
      models: [
        { id: 'default', label: 'Auto', efforts: [] },
        { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
      ],
    })
    expect(events).toContainEqual({ kind: 'settings', settings: { model: 'default' } })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('loads an existing session and maps the replayed history into positional rows', async () => {
    const { rpc, events, adapter, imports } = setup()
    rpc.replies.set('session/load', () => {
      rpc.update('sess-old', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'make a file' } })
      rpc.update('sess-old', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning.' } })
      rpc.update('sess-old', { sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', title: '`touch a`', kind: 'execute', status: 'pending', rawInput: { command: 'touch a' } })
      rpc.update('sess-old', { sessionUpdate: 'tool_call_update', toolCallId: 'replay-0-1', status: 'completed', rawOutput: { exitCode: 0, stdout: '', stderr: '' } })
      rpc.update('sess-old', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
      rpc.update('someone-else', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } })
      return { configOptions: [modelOption('default')] }
    })
    await adapter.open({ cwd: '/work', conversationId: 'sess-old', settings: {} })

    expect(imports).toEqual([['sess-old', '/work', 'false']])
    expect(params(rpc, 'session/load')).toEqual([{ sessionId: 'sess-old', cwd: '/work', mcpServers: [] }])
    expect(rpc.requests.some((call) => call.method === 'session/new')).toBe(false)
    expect(events).toContainEqual({ kind: 'conversation', conversationId: 'sess-old' })
    expect(messages(events)).toEqual([
      { uid: 'cursor:sess-old:0', role: 'user', blocks: [{ kind: 'text', text: 'make a file' }] },
      { uid: 'cursor:sess-old:1', role: 'assistant', blocks: [{ kind: 'thinking', text: 'Planning.' }] },
      { uid: 'cursor:sess-old:2', role: 'assistant', blocks: [{ kind: 'tool', id: 'replay-0-1', name: 'command', input: 'touch a' }] },
      { uid: 'cursor:sess-old:2:result', role: 'tool', blocks: [{ kind: 'toolResult', forId: 'replay-0-1', output: '' }] },
      { uid: 'cursor:sess-old:3', role: 'assistant', blocks: [{ kind: 'text', text: 'done' }] },
    ])
  })

  it('resolves send on dispatch and streams chunks into one upserted row per segment', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    const turn = deferred<unknown>()
    rpc.replies.set('session/prompt', turn.promise)
    await adapter.send({ text: 'hi', images: ['/tmp/shot.png'], settings: {} })

    expect(params(rpc, 'session/prompt')).toEqual([{
      sessionId: 'sess-new',
      prompt: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
    }])
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'working' })
    rpc.update('sess-new', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
    rpc.update('sess-new', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    turn.resolve({ stopReason: 'end_turn' })
    await turn.promise
    await Promise.resolve()

    const rows = messages(events)
    expect(rows[0]).toMatchObject({ uid: 'cursor:sess-new:0', role: 'user', blocks: [{ kind: 'image', alt: 'shot.png' }, { kind: 'text', text: 'hi' }] })
    expect(rows.slice(1)).toEqual([
      { uid: 'cursor:sess-new:1', role: 'assistant', blocks: [{ kind: 'text', text: 'Hel' }] },
      { uid: 'cursor:sess-new:1', role: 'assistant', blocks: [{ kind: 'text', text: 'Hello' }] },
    ])
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('round-trips a permission request through respond', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    const answer = rpc.serverRequest('session/request_permission', permission, 0)

    const request = events.find((event) => event.kind === 'request')
    expect(request).toEqual({
      kind: 'request',
      request: { id: 'cursor:0:1', kind: 'approval', title: 'Run command?', detail: 'echo hi > hello.txt\nNot in allowlist: echo' },
    })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'waiting' })
    await adapter.respond({ requestId: 'cursor:0:1', decision: 'deny' })
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    expect(events).toContainEqual({ kind: 'request-resolved', requestId: 'cursor:0:1' })
    await expect(adapter.respond({ requestId: 'cursor:0:1', decision: 'allow' })).rejects.toThrow(/Unknown/)
  })

  it('auto-approves permission requests once in bypass mode', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: { permissionMode: 'bypass' } })
    await expect(rpc.serverRequest('session/request_permission', permission, 7))
      .resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(events.some((event) => event.kind === 'request')).toBe(false)
    expect(events).toContainEqual({ kind: 'settings', settings: { model: 'default', permissionMode: 'bypass' } })
  })

  it('interrupt cancels open requests and the turn, then settles idle on the cancelled reply', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    const turn = deferred<unknown>()
    rpc.replies.set('session/prompt', turn.promise)
    await adapter.send({ text: 'go', images: [], settings: {} })
    const answer = rpc.serverRequest('session/request_permission', permission, 3)
    await adapter.interrupt()

    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(rpc.notifications).toEqual([{ method: 'session/cancel', params: { sessionId: 'sess-new' } }])
    turn.resolve({ stopReason: 'cancelled' })
    await turn.promise
    await Promise.resolve()
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('configures model then effort through session config options', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    await adapter.configure({ model: 'gpt-5.5', effort: 'xhigh' })

    expect(params(rpc, 'session/set_config_option')).toEqual([
      { sessionId: 'sess-new', configId: 'model', value: 'gpt-5.5' },
      { sessionId: 'sess-new', configId: 'reasoning', value: 'extra-high' },
    ])
    expect(events.at(-1)).toEqual({ kind: 'settings', settings: { model: 'gpt-5.5', effort: 'xhigh' } })
    await expect(adapter.configure({ model: 'gpt-5.5', effort: 'max' })).rejects.toThrow(/Unsupported Cursor effort/)
  })

  it('refuses compaction and closes idempotently', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    await expect(adapter.compact()).rejects.toThrow('Cursor does not support compaction')
    await adapter.close()
    await adapter.close()
    expect(rpc.closed).toBe(true)
    expect(events.filter((event) => event.kind === 'status' && event.status === 'stopped')).toHaveLength(1)
  })

  it('surfaces a dead agent as an error', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.disconnect('Cursor agent exited (1)')
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'error', error: 'Cursor agent exited (1)' })
    await expect(adapter.send({ text: 'x', images: [], settings: {} })).rejects.toThrow(/not open/)
  })
})
