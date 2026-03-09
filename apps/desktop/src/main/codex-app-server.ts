import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

interface JsonRpcResponse {
  id?: number | string
  result?: unknown
  error?: {
    message?: string
  }
  method?: string
  params?: unknown
}

interface JsonRpcNotification {
  method?: string
  params?: unknown
}

type NotificationListener = (notification: JsonRpcNotification) => void

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private readyPromise: Promise<void> | null = null
  private nextId = 0
  private pending = new Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private stdoutRemainder = ''
  private notificationListeners = new Set<NotificationListener>()

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted()
    return this.sendRequest<T>(method, params)
  }

  stop(): void {
    this.readyPromise = null
    this.stdoutRemainder = ''

    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server stopped'))
    }
    this.pending.clear()
    this.notificationListeners.clear()

    this.child?.kill()
    this.child = null
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = (async () => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))
      child.stderr.on('data', () => {})
      child.on('exit', () => this.handleExit())
      child.on('error', (error) => this.handleFailure(error))

      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'orchestra',
          version: '0.0.0',
        },
      })
      this.sendNotification('initialized')
    })().catch((error) => {
      this.stop()
      throw error
    })

    return this.readyPromise
  }

  private handleStdout(chunk: string): void {
    const input = this.stdoutRemainder + chunk
    const lines = input.split('\n')
    this.stdoutRemainder = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse
        if (message.id == null) {
          if (typeof message.method === 'string') {
            for (const listener of this.notificationListeners) {
              listener({ method: message.method, params: message.params })
            }
          }
          continue
        }

        const id = typeof message.id === 'number' ? message.id : Number(message.id)
        const pending = this.pending.get(id)
        if (!pending) continue

        this.pending.delete(id)
        if (message.error) {
          pending.reject(new Error(message.error.message || `Codex app-server ${String(message.id)} failed`))
          continue
        }

        pending.resolve(message.result)
      } catch {}
    }
  }

  private handleExit(): void {
    this.handleFailure(new Error('Codex app-server exited'))
  }

  private handleFailure(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.child = null
    this.readyPromise = null
    this.stdoutRemainder = ''
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.child?.stdin.writable) return
    const payload = params == null ? { method } : { method, params }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'))
    }

    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
}

let client: CodexAppServerClient | null = null

export function getCodexAppServer(): CodexAppServerClient {
  if (!client) client = new CodexAppServerClient()
  return client
}

export function stopCodexAppServer(): void {
  client?.stop()
  client = null
}
