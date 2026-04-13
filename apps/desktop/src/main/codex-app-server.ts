import { spawn, type ChildProcess } from 'node:child_process'
import * as net from 'node:net'
import { buildCliChildEnv, resolveCodexExecPath } from './node-runtime'
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

interface JsonRpcServerRequest {
  id?: number | string
  method?: string
  params?: unknown
}

type NotificationListener = (notification: JsonRpcNotification) => void
type ServerRequestListener = (request: JsonRpcServerRequest) => void

const APP_SERVER_HOST = '127.0.0.1'
const APP_SERVER_CONNECT_TIMEOUT_MS = 10_000
const APP_SERVER_CONNECT_RETRY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, APP_SERVER_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })

  if (!address || typeof address === 'string') {
    throw new Error('Failed to reserve Codex app-server port')
  }

  return address.port
}

function messageDataToString(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8')
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

class CodexAppServerClient {
  private child: ChildProcess | null = null
  private socket: WebSocket | null = null
  private readyPromise: Promise<void> | null = null
  private remoteUrl: string | null = null
  private nextId = 0
  private pending = new Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private stderrLines: string[] = []
  private notificationListeners = new Set<NotificationListener>()
  private serverRequestListeners = new Set<ServerRequestListener>()

  getRemoteUrl(): string | null {
    return this.remoteUrl
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted()
    return this.sendRequest<T>(method, params)
  }

  stop(): void {
    this.readyPromise = null
    this.remoteUrl = null
    this.stderrLines = []

    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server stopped'))
    }
    this.pending.clear()
    this.notificationListeners.clear()
    this.serverRequestListeners.clear()

    if (this.socket) {
      try {
        this.socket.close()
      } catch {}
    }
    this.socket = null

    this.child?.kill()
    this.child = null
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener)
    return () => {
      this.serverRequestListeners.delete(listener)
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = (async () => {
      const command = resolveCodexExecPath() ?? 'codex'
      const env = buildCliChildEnv()
      const port = await reserveLoopbackPort()
      const remoteUrl = `ws://${APP_SERVER_HOST}:${port}`

      debugWorkState('codex-app-server-start', {
        command,
        remoteUrl,
        path: env.PATH ?? null,
      })

      const child = spawn(command, ['app-server', '--listen', remoteUrl], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
      })
      this.child = child
      this.remoteUrl = remoteUrl

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => this.handleStderr(chunk))
      child.on('exit', (code, signal) => this.handleExit(code, signal))
      child.on('error', (error) => {
        debugWorkState('codex-app-server-error', {
          command,
          remoteUrl,
          error: String(error),
          stack: error.stack?.slice(0, 500) ?? '',
          stderr: this.getStderrTail(),
        })
        this.handleFailure(error)
      })

      const socket = await this.connectWebSocket(remoteUrl)
      this.socket = socket
      socket.addEventListener('message', (event) => this.handleMessage(messageDataToString(event.data)))
      socket.addEventListener('close', () => {
        this.handleFailure(new Error('Codex app-server websocket closed'))
      })
      socket.addEventListener('error', () => {})

      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'orchestra',
          version: '0.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      })
      this.sendNotification('initialized')
    })().catch((error) => {
      this.stop()
      throw error
    })

    return this.readyPromise
  }

  private async connectWebSocket(remoteUrl: string): Promise<WebSocket> {
    const deadline = Date.now() + APP_SERVER_CONNECT_TIMEOUT_MS
    let lastError: Error | null = null

    while (Date.now() < deadline) {
      try {
        return await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(remoteUrl)
          const timeout = setTimeout(() => {
            cleanup()
            try {
              socket.close()
            } catch {}
            reject(new Error('Timed out connecting to Codex app-server'))
          }, 1_000)

          const cleanup = () => {
            clearTimeout(timeout)
            socket.removeEventListener('open', onOpen)
            socket.removeEventListener('error', onError)
            socket.removeEventListener('close', onClose)
          }

          const onOpen = () => {
            cleanup()
            resolve(socket)
          }

          const onError = () => {
            cleanup()
            reject(new Error('Codex app-server websocket connection failed'))
          }

          const onClose = () => {
            cleanup()
            reject(new Error('Codex app-server websocket closed before connect'))
          }

          socket.addEventListener('open', onOpen)
          socket.addEventListener('error', onError)
          socket.addEventListener('close', onClose)
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await delay(APP_SERVER_CONNECT_RETRY_MS)
      }
    }

    throw lastError ?? new Error('Timed out starting Codex app-server')
  }

  private handleMessage(rawMessage: string): void {
    const trimmed = rawMessage.trim()
    if (!trimmed) return

    try {
      const message = JSON.parse(trimmed) as JsonRpcResponse
      if (message.id == null) {
        if (typeof message.method === 'string') {
          for (const listener of this.notificationListeners) {
            listener({ method: message.method, params: message.params })
          }
        }
        return
      }

      if (typeof message.method === 'string' && message.result === undefined && message.error === undefined) {
        for (const listener of this.serverRequestListeners) {
          listener({ id: message.id, method: message.method, params: message.params })
        }
        return
      }

      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const pending = this.pending.get(id)
      if (!pending) return

      this.pending.delete(id)
      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex app-server ${String(message.id)} failed`))
        return
      }

      pending.resolve(message.result)
    } catch {}
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
      remoteUrl: this.remoteUrl,
      stderr: this.getStderrTail(),
    })
    this.handleFailure(new Error('Codex app-server exited'))
  }

  private handleFailure(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()

    if (this.socket) {
      try {
        this.socket.close()
      } catch {}
    }
    this.socket = null

    this.child?.kill()
    this.child = null
    this.readyPromise = null
    this.remoteUrl = null
    this.stderrLines = []
  }

  private sendNotification(method: string, params?: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const payload = params == null ? { method } : { method, params }
    this.socket.send(JSON.stringify(payload))
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex app-server is not running'))
    }

    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = params === undefined ? { id, method } : { id, method, params }
      this.socket!.send(JSON.stringify(payload))
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
