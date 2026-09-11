/** One owner for mutations to each conversation's input transport. */
export class ChatInputController {
  private readonly sessions = new Map<string, { cancellation: AbortController; tail: Promise<unknown> }>()

  run<T>(sessionId: string, operation: (check: () => void) => Promise<T>): Promise<T> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { cancellation: new AbortController(), tail: Promise.resolve() }
      this.sessions.set(sessionId, session)
    }
    const owner = session
    const signal = owner.cancellation.signal
    const check = (): void => {
      if (signal.aborted) throw new Error('Chat input cancelled')
    }
    const operationResult = owner.tail.then(async () => {
      check()
      const value = await operation(check)
      check()
      return value
    })
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Chat input cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    // Cancellation releases callers and the queue immediately, including while
    // external I/O is stalled. The abandoned operation still checks its signal
    // before every write, so it cannot type into a later conversation turn.
    const result = Promise.race([operationResult, cancelled]).finally(() => {
      signal.removeEventListener('abort', abort)
    })
    // Keep a fulfilled tail so a failed operation cannot poison the queue or
    // leave an unhandled rejection behind when the caller catches its result.
    const tail = result.then(() => {}, () => {})
    owner.tail = tail
    void tail.then(() => {
      if (owner.tail === tail) this.sessions.delete(sessionId)
    })
    return result
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.cancellation.abort()
      session.cancellation = new AbortController()
    }
  }
}

/** Guard every transport write and every asynchronous pacing boundary. */
export function guardedChatInput<T extends {
  write: (data: string) => void
  sleep: (ms: number) => Promise<void>
}>(deps: T, check: () => void): T {
  return {
    ...deps,
    write(data: string) { check(); deps.write(data) },
    async sleep(ms: number) { check(); await deps.sleep(ms); check() },
  }
}

/** Desktop IPC and remote commands must share the same transport owner. */
export const chatInputController = new ChatInputController()
