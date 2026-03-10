import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildCliChildEnv, resolveCommandExecPath } from './node-runtime'
import { debugWorkState } from './work-state-debug'

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
  private stderrLines: string[] = []
  private notificationListeners = new Set<NotificationListener>()

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted()
    return this.sendRequest<T>(method, params)
  }

  stop(): void {
    this.readyPromise = null
    this.stdoutRemainder = ''
    this.stderrLines = []

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
      const command = resolveCommandExecPath('codex') ?? 'codex'
      const env = buildCliChildEnv()
      debugWorkState('codex-app-server-start', {
        command,
        path: env.PATH ?? null,
      })

      const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      child.stdout.on('data', (chunk: string) => this.handleStdout(chunk))
      child.stderr.on('data', (chunk: string) => this.handleStderr(chunk))
      child.on('exit', (code, signal) => this.handleExit(code, signal))
      child.on('error', (error) => {
        debugWorkState('codex-app-server-error', {
          command,
          error: String(error),
          stack: error.stack?.slice(0, 500) ?? '',
          stderr: this.getStderrTail(),
        })
        this.handleFailure(error)
      })

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

  private handleStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.stderrLines.push(trimmed)
      if (this.stderrLines.length > 20) {
        this.stderrLines.shift()
      }
    }
  }

  private getStderrTail(): string {
    return this.stderrLines.slice(-5).join(' | ')
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    debugWorkState('codex-app-server-exit', {
      code,
      signal,
      stderr: this.getStderrTail(),
    })
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
    this.stderrLines = []
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
