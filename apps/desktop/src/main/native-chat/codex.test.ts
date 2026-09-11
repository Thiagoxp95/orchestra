import { describe, expect, it } from 'vitest'
import type { NativeChatReply } from '../../shared/native-chat'
import type { ProviderEvent } from './provider'
import type {
  CodexRpcTransport,
  JsonRpcId,
  RpcNotificationHandler,
  RpcRequestHandler,
} from './codex-rpc'
import { createCodexAdapter } from './codex'

type Call = { method: string; params: unknown }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class FakeTransport implements CodexRpcTransport {
  readonly requests: Call[] = []
  readonly notifications: Call[] = []
  readonly replies = new Map<string, unknown>()
  closed = false
  disconnectOnClose = false
  private notificationHandler: RpcNotificationHandler = () => {}
  private requestHandler: RpcRequestHandler = async () => ({})
  private disconnectHandler: (error: Error) => void = () => {}

  constructor() {
    this.replies.set('initialize', { userAgent: 'codex-cli/0.154.0' })
    this.replies.set('model/list', {
      data: [{
        id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', description: '',
        hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'medium', description: '' },
          { reasoningEffort: 'high', description: '' },
        ],
      }],
    })
    this.replies.set('thread/start', {
      thread: { id: 'thread-new' }, cwd: '/work', model: 'gpt-5.4',
      modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    })
    this.replies.set('thread/resume', {
      thread: { id: 'thread-old' }, cwd: '/work', model: 'gpt-5.4',
      modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    })
    this.replies.set('turn/start', { turn: { id: 'queued-turn', status: 'inProgress', items: [] } })
    this.replies.set('turn/interrupt', {})
    this.replies.set('thread/compact/start', {})
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    const reply = this.replies.get(method)
    if (reply instanceof Error) throw reply
    return reply ?? {}
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params })
  }

  onNotification(handler: RpcNotificationHandler): void {
    this.notificationHandler = handler
  }

  onRequest(handler: RpcRequestHandler): void {
    this.requestHandler = handler
  }

  onDisconnect(handler: (error: Error) => void): void {
    this.disconnectHandler = handler
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.disconnectOnClose) this.disconnectHandler(new Error('closed pipe'))
  }

  serverNotify(method: string, params: unknown): void {
    this.notificationHandler(method, params)
  }

  serverRequest(method: string, params: unknown, id: JsonRpcId): Promise<unknown> {
    return this.requestHandler(method, params, id)
  }

  disconnect(message = 'app-server exited'): void {
    this.disconnectHandler(new Error(message))
  }
}

function setup() {
  const rpc = new FakeTransport()
  const events: ProviderEvent[] = []
  const adapter = createCodexAdapter((event) => events.push(event), {
    createTransport: () => rpc,
  })
  return { rpc, events, adapter }
}

function setupWithTransports(...transports: FakeTransport[]) {
  const events: ProviderEvent[] = []
  let index = 0
  const adapter = createCodexAdapter((event) => events.push(event), {
    createTransport: () => transports[index++] ?? (() => { throw new Error('missing fake transport') })(),
  })
  return { events, adapter }
}

function requestParams(rpc: FakeTransport, method: string): Record<string, unknown> {
  return rpc.requests.find((call) => call.method === method)?.params as Record<string, unknown>
}

describe('createCodexAdapter', () => {
  it('initializes Codex and starts a thread with user-reviewed approvals', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: { model: 'gpt-5.4', effort: 'high' } })

    expect(rpc.requests[0]).toEqual({
      method: 'initialize',
      params: {
        clientInfo: { name: 'orchestra', title: 'Orchestra', version: '1.21.67' },
        capabilities: { experimentalApi: true },
      },
    })
    expect(rpc.notifications[0]).toEqual({ method: 'initialized', params: {} })
    expect(requestParams(rpc, 'thread/start')).toEqual({
      cwd: '/work', model: 'gpt-5.4', approvalPolicy: 'on-request',
      approvalsReviewer: 'user', sandbox: 'workspace-write',
    })
    expect(events).toContainEqual({
      kind: 'catalog',
      models: [{ id: 'gpt-5.4', label: 'GPT-5.4', efforts: ['low', 'medium', 'high'] }],
    })
    expect(events).toContainEqual({ kind: 'conversation', conversationId: 'thread-new' })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('pins an omitted model to the advertised default for the thread and turns', async () => {
    const { rpc, events, adapter } = setup()
    rpc.replies.set('model/list', {
      data: [
        {
          id: 'first-valid', model: 'first-valid', displayName: 'First',
          hidden: false, isDefault: false, supportedReasoningEfforts: [],
        },
        {
          id: 'provider-default', model: 'provider-default', displayName: 'Provider Default',
          hidden: false, isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
        },
      ],
    })

    await adapter.open({ cwd: '/work', settings: {} })
    expect(requestParams(rpc, 'thread/start')).toMatchObject({ model: 'provider-default' })
    expect(events).toContainEqual({ kind: 'settings', settings: { model: 'provider-default' } })
    expect(events.findIndex((event) => event.kind === 'settings')).toBeGreaterThan(
      events.findIndex((event) => event.kind === 'conversation'),
    )

    await adapter.send({ text: 'hello', images: [], settings: {} })
    expect(requestParams(rpc, 'turn/start')).toMatchObject({ model: 'provider-default' })
  })

  it('resumes the requested thread with current cwd and settings', async () => {
    const { rpc, adapter } = setup()
    await adapter.open({
      cwd: '/work', conversationId: 'thread-old', settings: { model: 'gpt-5.4' },
    })
    expect(requestParams(rpc, 'thread/resume')).toEqual({
      threadId: 'thread-old', cwd: '/work', model: 'gpt-5.4', excludeTurns: false,
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
    })
  })

  it('rehydrates bounded recent history from a resumed thread with live-compatible uids', async () => {
    const { rpc, events, adapter } = setup()
    rpc.replies.set('thread/resume', {
      thread: {
        id: 'thread-old',
        turns: Array.from({ length: 205 }, (_, index) => ({
          id: `t${index}`,
          status: 'completed',
          startedAt: 1_780_000_000 + index,
          items: [{
            id: `user-${index}`, type: 'userMessage',
            content: [{ type: 'text', text: `prompt ${index}` }],
          }],
        })),
      },
      cwd: '/work', model: 'gpt-5.4', modelProvider: 'openai',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    })
    await adapter.open({ cwd: '/work', conversationId: 'thread-old', settings: {} })

    const messages = events.flatMap((event) => event.kind === 'messages' ? event.messages : [])
    expect(messages).toHaveLength(200)
    expect(messages[0]).toEqual({
      uid: 'codex:thread-old:t5:user', role: 'user',
      blocks: [{ kind: 'text', text: 'prompt 5' }], ts: 1_780_000_005_000,
    })
    expect(messages.at(-1)?.uid).toBe('codex:thread-old:t204:user')
  })

  it('rehydrates assistant, reasoning, and tool results from resume fixtures', async () => {
    const { rpc, events, adapter } = setup()
    rpc.replies.set('thread/resume', {
      thread: {
        id: 'thread-old',
        turns: [{
          id: 't1', status: 'completed', completedAt: 1_780_000_100,
          items: [
            { id: 'answer', type: 'agentMessage', text: 'Done' },
            { id: 'thought', type: 'reasoning', summary: ['Checked it'], content: [] },
            {
              id: 'cmd', type: 'commandExecution', command: 'pwd', cwd: '/work',
              status: 'completed', commandActions: [], aggregatedOutput: '/work\n', exitCode: 0,
            },
          ],
        }],
      },
      cwd: '/work', model: 'gpt-5.4', modelProvider: 'openai',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' },
    })
    await adapter.open({ cwd: '/work', conversationId: 'thread-old', settings: {} })

    const messages = events.flatMap((event) => event.kind === 'messages' ? event.messages : [])
    expect(messages.map((message) => message.uid)).toEqual([
      'codex:thread-old:t1:answer',
      'codex:thread-old:t1:thought',
      'codex:thread-old:t1:cmd',
      'codex:thread-old:t1:cmd:result',
    ])
    expect(messages.at(-1)?.blocks).toEqual([
      { kind: 'toolResult', forId: 'cmd', output: '/work\n' },
    ])
  })

  it('applies model and effort per turn, sends local images, and resolves at acceptance', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    await adapter.send({
      text: 'hello', images: ['/tmp/one.png'], settings: { model: 'gpt-5.4', effort: 'high' },
    })

    expect(requestParams(rpc, 'turn/start')).toEqual({
      threadId: 'thread-new',
      input: [{ type: 'text', text: 'hello' }, { type: 'localImage', path: '/tmp/one.png' }],
      model: 'gpt-5.4', effort: 'high', approvalPolicy: 'on-request',
      approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' },
    })
    expect(events).toContainEqual({
      kind: 'messages',
      messages: [{
        uid: 'codex:thread-new:queued-turn:user', role: 'user',
        blocks: [{ kind: 'text', text: 'hello' }, { kind: 'image', alt: 'one.png' }],
      }],
    })
  })

  it('does not resolve send or echo the user message before turn/start is accepted', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    const accepted = deferred<unknown>()
    rpc.replies.set('turn/start', accepted.promise)
    let settled = false
    const sending = adapter.send({ text: 'wait', images: [], settings: {} }).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(events.some((event) => event.kind === 'messages')).toBe(false)
    accepted.resolve({ turn: { id: 'accepted', status: 'inProgress', items: [] } })
    await sending
    expect(settled).toBe(true)
    expect(events.some((event) => event.kind === 'messages')).toBe(true)
  })

  it('interrupts only the turn identified by an actual turn/started notification', async () => {
    const { rpc, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.replies.set('turn/start', { turn: { id: 'actual-turn', status: 'inProgress', items: [] } })
    await adapter.send({ text: 'queued', images: [], settings: {} })
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 'actual-turn', status: 'inProgress', items: [] },
    })
    await adapter.interrupt()
    expect(requestParams(rpc, 'turn/interrupt')).toEqual({
      threadId: 'thread-new', turnId: 'actual-turn',
    })
  })

  it('cancels a pending turn/start without allowing late work and resumes on the next send', async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    first.disconnectOnClose = true
    const accepted = deferred<unknown>()
    first.replies.set('turn/start', accepted.promise)
    second.replies.set('thread/resume', {
      thread: { id: 'thread-new' }, cwd: '/work', model: 'gpt-5.4',
      modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite' },
    })
    second.replies.set('turn/start', { turn: { id: 'next-turn', status: 'inProgress', items: [] } })
    const { events, adapter } = setupWithTransports(first, second)
    await adapter.open({ cwd: '/work', settings: {} })

    const sending = adapter.send({ text: 'must stop', images: [], settings: {} })
    await Promise.resolve()
    await adapter.interrupt()
    expect(first.closed).toBe(true)
    expect(events.some((event) => event.kind === 'status' && event.status === 'error')).toBe(false)
    accepted.resolve({ turn: { id: 'late-turn', status: 'inProgress', items: [] } })
    await expect(sending).rejects.toThrow(/cancel/i)
    expect(events.some((event) =>
      event.kind === 'messages' && event.messages.some((message) => message.uid.includes('late-turn')),
    )).toBe(false)

    await adapter.send({ text: 'next', images: [], settings: {} })
    expect(second.requests.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(events.some((event) =>
      event.kind === 'messages' && event.messages.some((message) => message.uid.includes('next-turn')),
    )).toBe(true)
  })

  it('closes the owner when Stop lands after acceptance but before turn/started', async () => {
    const rpc = new FakeTransport()
    const { events, adapter } = setupWithTransports(rpc)
    await adapter.open({ cwd: '/work', settings: {} })
    await adapter.send({ text: 'accepted but not started', images: [], settings: {} })

    await adapter.interrupt()
    expect(rpc.closed).toBe(true)
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 'queued-turn', status: 'inProgress', items: [] },
    })
    expect(rpc.requests.filter((call) => call.method === 'turn/interrupt')).toEqual([])
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('cancels an unresolved compact request without a late compacting status', async () => {
    const first = new FakeTransport()
    const accepted = deferred<unknown>()
    first.replies.set('thread/compact/start', accepted.promise)
    const { events, adapter } = setupWithTransports(first)
    await adapter.open({ cwd: '/work', settings: {} })
    const compacting = adapter.compact()
    await Promise.resolve()

    await adapter.interrupt()
    expect(first.closed).toBe(true)
    accepted.resolve({})
    await expect(compacting).rejects.toThrow(/cancel/i)
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
  })

  it('settles an outstanding approval when Stop interrupts the active turn', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 't1', status: 'inProgress', items: [] },
    })
    const approval = rpc.serverRequest('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 't1', itemId: 'patch', startedAtMs: 1,
    }, 'approval')
    const request = events.findLast((event) => event.kind === 'request')
    if (!request || request.kind !== 'request') throw new Error('missing approval request')

    await adapter.interrupt()
    await expect(Promise.race([
      approval,
      new Promise((_, reject) => setTimeout(() => reject(new Error('approval remained pending')), 20)),
    ])).resolves.toEqual({ decision: 'decline' })
    expect(events).toContainEqual({ kind: 'request-resolved', requestId: request.request.id })
  })

  it('emits stable-uid full snapshots for streamed messages and tool output', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.serverNotify('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 't1', itemId: 'answer', delta: 'Hello',
    })
    rpc.serverNotify('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 't1', itemId: 'answer', delta: ' world',
    })
    rpc.serverNotify('item/started', {
      threadId: 'thread-new', turnId: 't1', startedAtMs: 10,
      item: { id: 'cmd', type: 'commandExecution', command: 'pwd', cwd: '/work', status: 'inProgress', commandActions: [] },
    })
    rpc.serverNotify('item/commandExecution/outputDelta', {
      threadId: 'thread-new', turnId: 't1', itemId: 'cmd', delta: '/work\n',
    })

    const messages = events.flatMap((event) => event.kind === 'messages' ? event.messages : [])
    expect(messages.filter((message) => message.uid.endsWith(':answer'))).toEqual([
      { uid: 'codex:thread-new:t1:answer', role: 'assistant', blocks: [{ kind: 'text', text: 'Hello' }] },
      { uid: 'codex:thread-new:t1:answer', role: 'assistant', blocks: [{ kind: 'text', text: 'Hello world' }] },
    ])
    expect(messages).toContainEqual({
      uid: 'codex:thread-new:t1:cmd', role: 'assistant',
      blocks: [{ kind: 'tool', id: 'cmd', name: 'command', input: 'pwd' }], ts: 10,
    })
    expect(messages).toContainEqual({
      uid: 'codex:thread-new:t1:cmd:result', role: 'tool',
      blocks: [{ kind: 'toolResult', forId: 'cmd', output: '/work\n' }],
    })
  })

  it('keeps the latest tail when a streamed message exceeds its wire cap', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.serverNotify('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 't1', itemId: 'long', delta: 'a'.repeat(7_000),
    })
    rpc.serverNotify('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 't1', itemId: 'long', delta: 'THE END',
    })
    const message = events.findLast((event) =>
      event.kind === 'messages' && event.messages[0]?.uid.endsWith(':long'),
    )
    expect(message?.kind).toBe('messages')
    if (!message || message.kind !== 'messages') throw new Error('missing streamed message')
    const block = message.messages[0]?.blocks[0]
    expect(block?.kind).toBe('text')
    expect(block && 'text' in block ? block.text : '').toMatch(/THE END$/)
    expect(block && 'text' in block ? block.text.length : 0).toBeLessThanOrEqual(6_000)
  })

  it('round-trips command approvals and user-input questions', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 't1', status: 'inProgress', items: [] },
    })
    const approval = rpc.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-new', turnId: 't1', itemId: 'cmd', command: 'rm file', reason: 'delete it',
      startedAtMs: 1, availableDecisions: ['accept', 'decline'],
    }, 'a1')
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'waiting' })
    const approvalRequest = events.find((event) => event.kind === 'request' && event.request.kind === 'approval')
    expect(approvalRequest?.kind).toBe('request')
    if (!approvalRequest || approvalRequest.kind !== 'request') throw new Error('missing approval request')
    await adapter.respond({ requestId: approvalRequest.request.id, decision: 'deny' })
    await expect(approval).resolves.toEqual({ decision: 'decline' })

    const question = rpc.serverRequest('item/tool/requestUserInput', {
      threadId: 'thread-new', turnId: 't1', itemId: 'q1', isBlocking: true,
      questions: [{ id: 'choice', header: 'Pick', question: 'Which?', options: [{ label: 'A', description: 'first' }] }],
    }, 7)
    const questionEvent = events.findLast((event) => event.kind === 'request' && event.request.kind === 'question')
    expect(questionEvent?.kind).toBe('request')
    if (!questionEvent || questionEvent.kind !== 'request') throw new Error('missing question request')
    await adapter.respond({
      requestId: questionEvent.request.id,
      answers: { choice: ['A'] },
    })
    await expect(question).resolves.toEqual({ answers: { choice: { answers: ['A'] } } })
  })

  it('stays waiting until every concurrent provider request is answered', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 't1', status: 'inProgress', items: [] },
    })
    const first = rpc.serverRequest('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 't1', itemId: 'p1', startedAtMs: 1,
    }, 'p1')
    const second = rpc.serverRequest('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 't1', itemId: 'p2', startedAtMs: 1,
    }, 'p2')
    const requests = events.filter((event) => event.kind === 'request')
    if (requests[0]?.kind !== 'request' || requests[1]?.kind !== 'request') {
      throw new Error('missing concurrent approval requests')
    }
    await adapter.respond({ requestId: requests[0].request.id, decision: 'allow' })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'waiting' })
    await adapter.respond({ requestId: requests[1].request.id, decision: 'deny' })
    await Promise.all([first, second])
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'working' })
  })

  it('validates configured settings against the provider catalog and uses them later', async () => {
    const invalid = setup()
    await expect(invalid.adapter.open({
      cwd: '/work', settings: { model: 'unknown' },
    })).rejects.toThrow(/unknown model/i)

    const { rpc, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    await expect(adapter.configure({ model: 'unknown' })).rejects.toThrow(/unknown model/i)
    await expect(adapter.configure({ model: 'gpt-5.4', effort: 'ultra' })).rejects.toThrow(/effort/i)
    await adapter.configure({ model: 'gpt-5.4', effort: 'low' })
    await adapter.send({ text: 'configured', images: [], settings: {} })
    expect(requestParams(rpc, 'turn/start')).toMatchObject({ model: 'gpt-5.4', effort: 'low' })
  })

  it('tracks compaction completion, turn failure, disconnect, and close', async () => {
    const { rpc, events, adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    await adapter.compact()
    expect(requestParams(rpc, 'thread/compact/start')).toEqual({ threadId: 'thread-new' })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'compacting' })
    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 'compact-1', status: 'inProgress', items: [] },
    })
    rpc.serverNotify('thread/compacted', { threadId: 'thread-new', turnId: 'compact-1' })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'idle' })
    await adapter.interrupt()
    expect(rpc.requests.filter((call) => call.method === 'turn/interrupt')).toEqual([])

    rpc.serverNotify('turn/started', {
      threadId: 'thread-new', turn: { id: 't1', status: 'inProgress', items: [] },
    })
    rpc.serverNotify('turn/completed', {
      threadId: 'thread-new', turn: { id: 't1', status: 'failed', items: [], error: { message: 'boom' } },
    })
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'error', error: 'boom' })
    rpc.disconnect('lost child')
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'error', error: 'lost child' })
    await adapter.close()
    expect(rpc.closed).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'status', status: 'stopped' })
  })

  it('cleans up a failed open and rejects pending user decisions on disconnect', async () => {
    const failed = setup()
    failed.rpc.replies.set('thread/start', new Error('cannot start'))
    await expect(failed.adapter.open({ cwd: '/work', settings: {} })).rejects.toThrow('cannot start')
    expect(failed.rpc.closed).toBe(true)

    const connected = setup()
    await connected.adapter.open({ cwd: '/work', settings: {} })
    const approval = connected.rpc.serverRequest('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 't1', itemId: 'patch', startedAtMs: 1,
    }, 'pending')
    connected.rpc.disconnect('process died')
    await expect(approval).rejects.toThrow('process died')
  })

  it('rejects malformed replies and unknown pending requests', async () => {
    const { adapter } = setup()
    await adapter.open({ cwd: '/work', settings: {} })
    const replies: NativeChatReply[] = [
      { requestId: 'missing', decision: 'allow' },
      { requestId: 'missing', answers: {} },
    ]
    for (const reply of replies) await expect(adapter.respond(reply)).rejects.toThrow(/unknown/i)
  })
})
