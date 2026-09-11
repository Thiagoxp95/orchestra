import type { Readable, Writable } from 'node:stream'

export type JsonRpcId = string | number
export type RpcNotificationHandler = (method: string, params: unknown) => void
export type RpcRequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>

export interface CodexRpcTransport {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  onNotification(handler: RpcNotificationHandler): void
  onRequest(handler: RpcRequestHandler): void
  onDisconnect(handler: (error: Error) => void): void
  close(): Promise<void>
}

type PendingRequest = {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type JsonRpcMessage = {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class JsonLineRpcTransport implements CodexRpcTransport {
  private nextId = 1
  private buffer = ''
  private ended = false
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private notificationHandler: RpcNotificationHandler = () => {}
  private requestHandler: RpcRequestHandler = async (method) => {
    throw Object.assign(new Error(`Unsupported Codex server request: ${method}`), { code: -32601 })
  }
  private disconnectHandler: (error: Error) => void = () => {}

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 30_000,
    private readonly stopProcess: () => Promise<void> = async () => {},
  ) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.acceptChunk(chunk))
    input.once('end', () => this.disconnect(new Error('Codex app-server disconnected')))
    input.once('error', (error) => this.disconnect(error))
    output.once('error', (error) => this.disconnect(error))
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('Codex app-server is disconnected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
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
    if (!this.ended) this.disconnect(new Error('Codex app-server closed'))
    this.input.removeAllListeners()
    this.output.removeAllListeners()
    await this.stopProcess()
  }

  private write(message: JsonRpcMessage): void {
    if (this.ended) throw new Error('Codex app-server is disconnected')
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private acceptChunk(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch (error) {
        this.disconnect(new Error(`Invalid JSON from Codex app-server: ${errorMessage(error)}`))
        return
      }
      this.acceptMessage(message)
    }
  }

  private acceptMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(
          `Codex app-server ${pending.method} failed: ${message.error.message ?? 'unknown error'}`,
        )
        Object.assign(error, { code: message.error.code, data: message.error.data })
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method !== 'string') return
    if (message.id === undefined) {
      this.notificationHandler(message.method, message.params)
      return
    }

    void this.requestHandler(message.method, message.params, message.id).then(
      (result) => this.writeIfConnected({ id: message.id, result }),
      (cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        const code = typeof (cause as { code?: unknown })?.code === 'number'
          ? (cause as { code: number }).code
          : -32603
        this.writeIfConnected({ id: message.id, error: { code, message: error.message } })
      },
    )
  }

  private writeIfConnected(message: JsonRpcMessage): void {
    if (this.ended) return
    try {
      this.write(message)
    } catch (error) {
      this.disconnect(error)
    }
  }

  private disconnect(cause: unknown): void {
    if (this.ended) return
    this.ended = true
    const error = cause instanceof Error ? cause : new Error(String(cause))
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.disconnectHandler(error)
  }
}
