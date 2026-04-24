// src/main/daemon-client.ts
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { BrowserWindow } from 'electron'
import {
  DAEMON_SOCKET_PATH, sendJson, createJsonParser,
  DaemonResponse, DaemonEvent, SessionSnapshot, SessionInfo
} from '../daemon/protocol'
import { ensureDaemon } from './daemon-launcher'
import { closeInterruptionPopup, forwardToPopup } from './interruption-popup'
import { feedTerminalOutput } from './terminal-output-buffer'
import { summarizePrompt } from './prompt-summarizer'
import { getSessionStatus } from './process-monitor'
import { feedTerminalNotifications, clearTerminalNotificationParser, type TerminalNotificationEvent } from './terminal-notification-parser'
import { getClaudeWorkStateFromChunk, type ClaudeWorkState } from './claude-work-indicator'
import { notifyTerminalAttention } from './idle-notifier'
import type { TerminalLaunchProfile } from '../shared/types'

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
  private reconnecting = false
  private claudeTitleRemainder = new Map<string, string>()
  private claudeWorkState = new Map<string, ClaudeWorkState>()

  async connect(window: BrowserWindow): Promise<void> {
    this.window = window
    await this.establishConnection()
  }

  private async establishConnection(): Promise<void> {
    await ensureDaemon()

    // Generate fresh clientId for each connection attempt
    this.clientId = crypto.randomUUID()

    // Open control socket
    this.controlSocket = await this.openSocket('control')

    // Open stream socket
    this.streamSocket = await this.openSocket('stream')

    // Listen for events on stream socket
    const parseStream = createJsonParser((msg: DaemonEvent) => {
      if (msg.type === 'event' && this.window && !this.window.isDestroyed()) {
        if (msg.event === 'data') {
          feedTerminalOutput(msg.sessionId, msg.data)
          feedTerminalNotifications(msg.sessionId, msg.data, (notification) => {
            this.handleTerminalNotification(notification)
          })
          this.processClaudeWorkState(msg.sessionId, msg.data)
          this.window.webContents.send('terminal-data', msg.sessionId, msg.data)
          forwardToPopup(msg.sessionId, 'terminal-data', msg.sessionId, msg.data)
        } else if (msg.event === 'exit') {
          clearTerminalNotificationParser(msg.sessionId)
          this.claudeTitleRemainder.delete(msg.sessionId)
          this.claudeWorkState.delete(msg.sessionId)
          this.window.webContents.send('terminal-exit', msg.sessionId)
          closeInterruptionPopup(msg.sessionId)
        } else if (msg.event === 'prompt') {
          this.handlePromptEvent(msg.sessionId, msg.text)
        }
      }
    })
    this.streamSocket.setEncoding('utf8')
    this.streamSocket.on('data', (chunk: string) => parseStream(chunk))

    // Detect stream socket breakage
    this.streamSocket.on('close', () => this.handleSocketBreak())
    this.streamSocket.on('error', () => {})

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

    // Detect control socket breakage
    this.controlSocket.on('close', () => this.handleSocketBreak())
    this.controlSocket.on('error', () => {})

    this.connected = true
    this.reconnecting = false
    console.log('[daemon-client] Connected to daemon')
  }

  private handleSocketBreak(): void {
    if (!this.connected || this.reconnecting) return
    console.warn('[daemon-client] Socket broke, will reconnect on next request')
    this.connected = false
    // Reject all pending requests so callers can retry
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection lost'))
      this.pendingRequests.delete(id)
    }
    // Clean up dead sockets
    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
  }

  async reconnect(): Promise<void> {
    if (this.reconnecting) {
      // Wait for in-progress reconnect to finish instead of silently returning
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (!this.reconnecting) {
            clearInterval(check)
            if (this.connected) resolve()
            else reject(new Error('Reconnect failed'))
          }
        }, 100)
        setTimeout(() => { clearInterval(check); reject(new Error('Reconnect wait timeout')) }, 10000)
      })
      return
    }
    this.reconnecting = true
    console.log('[daemon-client] Reconnecting to daemon...')
    this.controlSocket?.destroy()
    this.streamSocket?.destroy()
    this.controlSocket = null
    this.streamSocket = null
    this.connected = false
    this.pendingRequests.clear()
    try {
      await this.establishConnection()
    } catch (err) {
      this.reconnecting = false
      throw err
    }
  }

  private openSocket(role: 'control' | 'stream'): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(DAEMON_SOCKET_PATH)
      socket.on('connect', () => {
        sendJson(socket, { type: 'hello', role, clientId: this.clientId })
        resolve(socket)
      })
      socket.on('error', (err) => {
        if (!socket.connecting) return // handled by close event after connection
        reject(err)
      })
    })
  }

  private async request(msg: any): Promise<any> {
    // Auto-reconnect if connection is broken
    if (!this.connected || !this.controlSocket) {
      await this.reconnect()
    }
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

  async sendRequest(msg: any): Promise<any> {
    return this.request(msg)
  }

  async createOrAttach(
    sessionId: string,
    opts: { cwd: string; cols: number; rows: number; env?: Record<string, string>; initialCommand?: string; launchProfile?: TerminalLaunchProfile }
  ): Promise<{ isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null; processSessionId: string }> {
    const resp = await this.request({
      type: 'createOrAttach',
      sessionId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
      initialCommand: opts.initialCommand,
      launchProfile: opts.launchProfile
    })
    return {
      isNew: resp.isNew,
      snapshot: resp.snapshot,
      pid: resp.pid,
      processSessionId: resp.processSessionId ?? sessionId,
    }
  }

  async prewarmShell(opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> }): Promise<void> {
    await this.request({
      type: 'prewarmShell',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
    })
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

  async suspend(sessionId: string): Promise<void> {
    await this.request({ type: 'suspend', sessionId })
  }

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await this.request({ type: 'listSessions' })
    return resp.sessions
  }

  async getPromptHistory(sessionId: string): Promise<any[]> {
    const resp = await this.request({ type: 'getPromptHistory', sessionId })
    return resp.records || []
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const resp = await this.request({ type: 'getSnapshot', sessionId })
    return resp.snapshot ?? null
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

  private processClaudeWorkState(sessionId: string, data: string): void {
    if (!this.window || this.window.isDestroyed()) return

    try {
      const oscMatches = data.match(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g)
      if (oscMatches && oscMatches.length > 0) {
        const line = `${new Date().toISOString()} session=${sessionId.slice(0, 8)} ` +
          oscMatches.slice(0, 8).map((s) => JSON.stringify(s.slice(0, 150))).join(' | ') +
          '\n'
        fs.appendFileSync('/tmp/orchestra-claude-work.log', line)
      }
    } catch {}


    const prevRemainder = this.claudeTitleRemainder.get(sessionId) ?? ''
    const { remainder, state } = getClaudeWorkStateFromChunk(data, prevRemainder)

    if (remainder) this.claudeTitleRemainder.set(sessionId, remainder)
    else this.claudeTitleRemainder.delete(sessionId)

    if (!state) return

    const prevState = this.claudeWorkState.get(sessionId)
    if (prevState === state) return

    this.claudeWorkState.set(sessionId, state)
    console.log(`[claude-work] session=${sessionId.slice(0, 8)} state=${state}`)
    this.window.webContents.send('claude-work-state', sessionId, state)
  }

  private handleTerminalNotification(notification: TerminalNotificationEvent): void {
    if (!this.window || this.window.isDestroyed()) return

    const status = getSessionStatus(notification.sessionId)
    if (status !== 'claude' && status !== 'codex') return

    const title = notification.body || notification.title
    const description = [notification.title, notification.subtitle]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' · ')

    notifyTerminalAttention(
      notification.sessionId,
      status,
      title,
      description || undefined,
    )
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
