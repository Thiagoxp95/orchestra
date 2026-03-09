// src/main/daemon-client.ts
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { BrowserWindow } from 'electron'
import {
  DAEMON_SOCKET_PATH, sendJson, createJsonParser,
  DaemonResponse, DaemonEvent, SessionSnapshot, SessionInfo
} from '../daemon/protocol'
import { ensureDaemon } from './daemon-launcher'
import { observeTerminalData } from './claude-session-watcher'
import { summarizePrompt } from './prompt-summarizer'
import { getSessionStatus } from './process-monitor'

export class DaemonClient {
  private controlSocket: net.Socket | null = null
  private streamSocket: net.Socket | null = null
  private clientId = crypto.randomUUID()
  private requestId = 0
  private pendingRequests = new Map<number | string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  private window: BrowserWindow | null = null
  private connected = false

  async connect(window: BrowserWindow): Promise<void> {
    this.window = window
    await ensureDaemon()

    // Open control socket
    this.controlSocket = await this.openSocket('control')

    // Open stream socket
    this.streamSocket = await this.openSocket('stream')

    // Listen for events on stream socket
    const parseStream = createJsonParser((msg: DaemonEvent) => {
      if (msg.type === 'event' && this.window && !this.window.isDestroyed()) {
        if (msg.event === 'data') {
          observeTerminalData(msg.sessionId, msg.data)
          this.window.webContents.send('terminal-data', msg.sessionId, msg.data)
        } else if (msg.event === 'exit') {
          this.window.webContents.send('terminal-exit', msg.sessionId)
        } else if (msg.event === 'prompt') {
          this.handlePromptEvent(msg.sessionId, msg.text)
        }
      }
    })
    this.streamSocket.setEncoding('utf8')
    this.streamSocket.on('data', (chunk: string) => parseStream(chunk))

    // Listen for responses on control socket
    const parseControl = createJsonParser((msg: DaemonResponse) => {
      if (msg.id != null) {
        const pending = this.pendingRequests.get(msg.id)
        if (pending) {
          this.pendingRequests.delete(msg.id)
          if (msg.ok) {
            pending.resolve(msg)
          } else {
            pending.reject(new Error(msg.error || 'Request failed'))
          }
        }
      }
    })
    this.controlSocket.setEncoding('utf8')
    this.controlSocket.on('data', (chunk: string) => parseControl(chunk))

    this.connected = true
  }

  private openSocket(role: 'control' | 'stream'): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(DAEMON_SOCKET_PATH)
      socket.on('connect', () => {
        sendJson(socket, { type: 'hello', role, clientId: this.clientId })
        resolve(socket)
      })
      socket.on('error', (err) => reject(err))
    })
  }

  private request(msg: any): Promise<any> {
    if (!this.controlSocket) throw new Error('Not connected')
    const id = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      sendJson(this.controlSocket!, { ...msg, id })
      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 10000)
    })
  }

  async createOrAttach(
    sessionId: string,
    opts: { cwd: string; cols: number; rows: number; initialCommand?: string }
  ): Promise<{ isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null }> {
    const resp = await this.request({
      type: 'createOrAttach',
      sessionId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      initialCommand: opts.initialCommand
    })
    return { isNew: resp.isNew, snapshot: resp.snapshot, pid: resp.pid }
  }

  write(sessionId: string, data: string, source: 'user' | 'system' = 'user'): void {
    // Fire-and-forget
    if (this.controlSocket) {
      sendJson(this.controlSocket, { type: 'write', sessionId, data, source })
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: 'resize', sessionId, cols, rows })
  }

  async kill(sessionId: string): Promise<void> {
    await this.request({ type: 'kill', sessionId })
  }

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await this.request({ type: 'listSessions' })
    return resp.sessions
  }

  async getPromptHistory(sessionId: string): Promise<any[]> {
    const resp = await this.request({ type: 'getPromptHistory', sessionId })
    return resp.records || []
  }

  detach(sessionId: string): void {
    if (this.controlSocket) {
      sendJson(this.controlSocket, { type: 'detach', sessionId })
    }
  }

  disconnect(): void {
    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
    this.connected = false
    this.pendingRequests.clear()
  }

  private handlePromptEvent(sessionId: string, text: string): void {
    if (!this.window || this.window.isDestroyed()) return
    // Only summarize prompts for agent sessions (Claude/Codex), not plain terminals
    const status = getSessionStatus(sessionId)
    if (status === 'terminal') return

    const win = this.window
    summarizePrompt(text)
      .then((summary) => {
        if (!win.isDestroyed()) {
          win.webContents.send('session-label-update', sessionId, summary)
        }
      })
      .catch((err) => {
        console.error(`[daemon-client] Summarization failed for ${sessionId}:`, err.message)
      })
  }

  isConnected(): boolean {
    return this.connected
  }
}

// Singleton
let client: DaemonClient | null = null

export function getDaemonClient(): DaemonClient {
  if (!client) client = new DaemonClient()
  return client
}
