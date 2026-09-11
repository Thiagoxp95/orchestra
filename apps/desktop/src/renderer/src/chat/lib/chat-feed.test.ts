import { describe, expect, it } from 'vitest'
import type { AgentChatLogEvent, AgentChatRow } from '../../../../shared/types'
import { ChatFeedController, type ChatFeedTransport } from './chat-feed'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function row(uid: string, seq: number, text: string): AgentChatRow {
  return { uid, seq, role: 'assistant', blocks: [{ kind: 'text', text }], ts: seq }
}

class FakeTransport implements ChatFeedTransport {
  readonly requests: Array<{
    beforeSeq: number
    result: ReturnType<typeof deferred<AgentChatRow[]>>
  }> = []
  private readonly listeners = new Set<(event: AgentChatLogEvent) => void>()

  before(_sessionId: string, beforeSeq: number): Promise<AgentChatRow[]> {
    const result = deferred<AgentChatRow[]>()
    this.requests.push({ beforeSeq, result })
    return result.promise
  }

  subscribe(listener: (event: AgentChatLogEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AgentChatLogEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

async function seed(controller: ChatFeedController, transport: FakeTransport, rows: AgentChatRow[]): Promise<void> {
  controller.start()
  transport.requests[0].result.resolve(rows)
  await transport.requests[0].result.promise
  await Promise.resolve()
}

describe('ChatFeedController', () => {
  it('does not let a pre-clear seed resurrect the previous conversation', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    controller.start()

    transport.emit({ kind: 'clear', sessionId: 's1' })
    transport.emit({ kind: 'append', sessionId: 's1', messages: [row('new', 11, 'new conversation')] })
    transport.requests[0].result.resolve([row('old', 1, 'previous conversation')])
    await transport.requests[0].result.promise
    await Promise.resolve()

    expect(controller.getSnapshot()).toMatchObject({
      seeded: true,
      afterSeq: 11,
      messages: [{ uid: 'new', seq: 11, blocks: [{ kind: 'text', text: 'new conversation' }] }],
    })
  })

  it('keeps a live patch when the older seed for the same uid resolves later', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    controller.start()

    transport.emit({ kind: 'append', sessionId: 's1', messages: [row('a', 7, 'final')] })
    transport.requests[0].result.resolve([row('a', 7, 'draft')])
    await transport.requests[0].result.promise
    await Promise.resolve()

    expect(controller.getSnapshot().messages).toMatchObject([
      { uid: 'a', blocks: [{ kind: 'text', text: 'final' }] },
    ])
  })

  it('does not let an earlier-page response outlive a clear', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    await seed(controller, transport, [row('current', 10, 'current')])
    let beforeCommitCalls = 0

    const loading = controller.loadEarlier(() => beforeCommitCalls++)
    transport.emit({ kind: 'clear', sessionId: 's1' })
    transport.requests[1].result.resolve([row('old', 1, 'old')])
    await loading

    expect(beforeCommitCalls).toBe(0)
    expect(controller.getSnapshot()).toMatchObject({
      messages: [],
      loadingEarlier: false,
      earlierError: false,
      afterSeq: 10,
    })
  })

  it('starts only one earlier-page request when called twice synchronously', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    await seed(controller, transport, [row('current', 10, 'current')])

    const first = controller.loadEarlier()
    const second = controller.loadEarlier()

    expect(transport.requests).toHaveLength(2)
    transport.requests[1].result.resolve([])
    await Promise.all([first, second])
  })

  it('does not let older history clobber a live patch of the same row', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    await seed(controller, transport, [row('current', 10, 'current')])

    const loading = controller.loadEarlier()
    transport.emit({ kind: 'append', sessionId: 's1', messages: [row('old', 2, 'final')] })
    transport.requests[1].result.resolve([row('old', 2, 'draft')])
    await loading

    expect(controller.getSnapshot().messages.find((message) => message.uid === 'old')).toMatchObject({
      blocks: [{ kind: 'text', text: 'final' }],
    })
  })

  it('ignores a seed that resolves after the controller is disposed', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    const snapshots: string[][] = []
    controller.subscribe((snapshot) => snapshots.push(snapshot.messages.map((message) => message.uid)))
    controller.start()

    controller.dispose()
    transport.requests[0].result.resolve([row('old', 1, 'old')])
    await transport.requests[0].result.promise
    await Promise.resolve()

    expect(snapshots).toEqual([])
    expect(controller.getSnapshot().messages).toEqual([])
  })

  it('does not start history work after the controller is disposed', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    await seed(controller, transport, [row('current', 10, 'current')])
    controller.dispose()

    const loading = controller.loadEarlier()

    expect(transport.requests).toHaveLength(1)
    if (transport.requests[1]) transport.requests[1].result.resolve([])
    await loading
  })

  it('keeps the cursor monotonic across clear and the new conversation', async () => {
    const transport = new FakeTransport()
    const controller = new ChatFeedController('s1', transport)
    await seed(controller, transport, [row('old', 10, 'old')])

    transport.emit({ kind: 'clear', sessionId: 's1' })
    expect(controller.getSnapshot().afterSeq).toBe(10)
    transport.emit({ kind: 'append', sessionId: 's1', messages: [row('new', 11, 'new')] })

    expect(controller.getSnapshot()).toMatchObject({
      afterSeq: 11,
      messages: [{ uid: 'new', seq: 11 }],
    })
  })
})
