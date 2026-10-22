import { decodeFrame, type StreamCheckpoint, type StreamRead } from '../shared/terminal-stream/protocol'
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
import { feedTerminalOutput, markWorkingStart } from './terminal-output-buffer'
import { getSessionStatus } from './process-monitor'
import { feedTerminalNotifications, clearTerminalNotificationParser, type TerminalNotificationEvent } from './terminal-notification-parser'
import { getClaudeWorkStateFromChunk, chunkContainsClaudePickerFooter, CLAUDE_IDLE_SETTLE_MS, type ClaudeWorkState } from './claude-work-indicator'
import { noteAgentWorking, notifyTerminalAttention, setSessionNotificationTitle } from './idle-notifier'
import { stripPromptImageTokens } from '../shared/prompt-image-tokens'
import { titleSessionFromPrompt } from './session-titler'
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
  private terminalStreamVersion: number | undefined
  private reconnecting = false
  private claudeTitleRemainder = new Map<string, string>()
  private claudeWorkState = new Map<string, ClaudeWorkState>()
  // Sticky flag: Claude's OSC title doesn't change when it opens a picker,
  // so we detect the picker footer in PTY output and override the work state
  // to `waitingUserInput` until the next legitimate OSC transition without
  // the footer still present (user picked or cancelled).
  private claudePickerActive = new Set<string>()
  // Idle titles that haven't earned their state change yet — see
  // CLAUDE_IDLE_SETTLE_MS. A working title behind one cancels it.
  private claudePendingIdle = new Map<string, ReturnType<typeof setTimeout>>()
  // The daemon only pushes 'data' events for sessions this client attached, and
  // the renderer attaches a pane lazily — the first time it is shown. After an
  // app restart (every auto-update) a Claude session nobody has opened on the
  // desktop yet is invisible to the title scraper, so its interrupted turns
  // (Esc fires no hook) stayed 'working' forever. Those sessions get their
  // titles pulled from the daemon's read-only terminal stream instead.
  private attachedSessions = new Set<string>()
  private titleTaps = new Map<string, { epoch: string; seq: string; offset: string; decoder: TextDecoder; busy: boolean }>()
  private claudeWorkStateHandler: ((sessionId: string, state: ClaudeWorkState) => void) | null = null
  private terminalExitHandler: ((sessionId: string) => void) | null = null
  private terminalDataTap: ((sessionId: string, data: string) => void) | null = null
  private claudeWorkStateSubscribers: ((sessionId: string, state: ClaudeWorkState) => void)[] = []
  private terminalExitSubscribers: ((sessionId: string) => void)[] = []

  async connect(window: BrowserWindow): Promise<void> {
    this.window = window
    await this.establishConnection()
  }

  setClaudeWorkStateHandler(handler: ((sessionId: string, state: ClaudeWorkState) => void) | null): void {
    this.claudeWorkStateHandler = handler
  }

  setTerminalExitHandler(handler: ((sessionId: string) => void) | null): void {
    this.terminalExitHandler = handler
  }

  setTerminalDataTap(handler: ((sessionId: string, data: string) => void) | null): void {
    this.terminalDataTap = handler
  }

  addClaudeWorkStateHandler(handler: (sessionId: string, state: ClaudeWorkState) => void): void {
    this.claudeWorkStateSubscribers.push(handler)
  }

  addTerminalExitHandler(handler: (sessionId: string) => void): void {
    this.terminalExitSubscribers.push(handler)
  }

  private async establishConnection(): Promise<void> {
    this.terminalStreamVersion = undefined
    // A new clientId has no stream attachments on the daemon side.
    this.attachedSessions.clear()
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
          this.terminalDataTap?.(msg.sessionId, msg.data)
          forwardToPopup(msg.sessionId, 'terminal-data', msg.sessionId, msg.data)
        } else if (msg.event === 'exit') {
          this.attachedSessions.delete(msg.sessionId)
          clearTerminalNotificationParser(msg.sessionId)
          this.claudeTitleRemainder.delete(msg.sessionId)
          this.cancelPendingClaudeIdle(msg.sessionId)
          this.claudeWorkState.delete(msg.sessionId)
          this.claudeWorkStateHandler?.(msg.sessionId, 'idle')
          for (const h of this.claudeWorkStateSubscribers) h(msg.sessionId, 'idle')
          this.terminalExitHandler?.(msg.sessionId)
          for (const h of this.terminalExitSubscribers) h(msg.sessionId)
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
    const hello = await this.request({ type: 'hello', role: 'control', clientId: this.clientId })
    this.terminalStreamVersion = hello.terminalStreamVersion
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

  async createOrAttach(sessionId: string, opts: { cwd: string; cols: number; rows: number; env?: Record<string, string>; initialCommand?: string; launchProfile?: TerminalLaunchProfile }): Promise<{ isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null; processSessionId: string }> {
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
    // From here the daemon pushes this session's output; a title tap would
    // feed every chunk to the scraper twice.
    this.attachedSessions.add(sessionId)
    this.titleTaps.delete(sessionId)
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

  write(sessionId: string, data: string, source: 'user' | 'system' | 'response' = 'user'): void {
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

  supportsTerminalStream(): boolean {
    return this.connected && this.terminalStreamVersion === 1
  }

  async getTerminalStreamCheckpoint(sessionId: string): Promise<StreamCheckpoint> {
    if (!this.supportsTerminalStream()) throw new Error('Daemon does not support terminal streaming')
    const response = await this.request({ type: 'getTerminalStreamCheckpoint', sessionId })
    return response.checkpoint
  }

  async readTerminalStream(sessionId: string, epoch: string, afterSeq: string, maxBytes: number, afterOffset?: string): Promise<StreamRead> {
    if (!this.supportsTerminalStream()) throw new Error('Daemon does not support terminal streaming')
    const response = await this.request({ type: 'readTerminalStream', sessionId, epoch, afterSeq, maxBytes, afterOffset })
    return response.stream
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
    if (getSessionStatus(sessionId) === 'terminal') return

    // A prompt that was only an attachment leaves nothing to name the session
    // with, so keep whatever label it already has instead of showing a path.
    const label = stripPromptImageTokens(text)
    if (!label) return
    titleSessionFromPrompt(sessionId, label, (title) => {
      if (!this.window || this.window.isDestroyed()) return
      setSessionNotificationTitle(sessionId, title)
      this.window.webContents.send('session-label-update', sessionId, title)
    })
  }

  private processClaudeWorkState(sessionId: string, data: string): void {
    if (!this.window || this.window.isDestroyed()) return

    if (getSessionStatus(sessionId) === 'codex') {
      this.claudeTitleRemainder.delete(sessionId)
      this.cancelPendingClaudeIdle(sessionId)
      const prevState = this.claudeWorkState.get(sessionId)
      if (prevState && prevState !== 'idle') {
        this.claudeWorkState.set(sessionId, 'idle')
        this.claudeWorkStateHandler?.(sessionId, 'idle')
        for (const h of this.claudeWorkStateSubscribers) h(sessionId, 'idle')
        this.window.webContents.send('claude-work-state', sessionId, 'idle')
      }
      return
    }

    // Raw title dump for diagnosing work-state bugs. Opt-in: it appends on every
    // chunk that carries an OSC sequence, which grows without bound.
    if (process.env['ORCHESTRA_DEBUG_CLAUDE_TITLES']) {
      try {
        const oscMatches = data.match(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g)
        if (oscMatches && oscMatches.length > 0) {
          const line = `${new Date().toISOString()} session=${sessionId.slice(0, 8)} ` +
            oscMatches.slice(0, 8).map((s) => JSON.stringify(s.slice(0, 150))).join(' | ') +
            '\n'
          fs.appendFileSync('/tmp/orchestra-claude-work.log', line)
        }
      } catch {}
    }

    const prevRemainder = this.claudeTitleRemainder.get(sessionId) ?? ''
    const { remainder, state: oscState } = getClaudeWorkStateFromChunk(data, prevRemainder)

    if (remainder) this.claudeTitleRemainder.set(sessionId, remainder)
    else this.claudeTitleRemainder.delete(sessionId)

    // Claude's picker prompt is purely a TUI element — the OSC title stays
    // on whatever it was before (usually 'working' if Claude is mid-turn).
    // Detect the picker footer in raw PTY output and override the state to
    // 'waitingUserInput' so the sidebar reflects "agent is blocked on user".
    // Clear the flag when a fresh OSC title arrives *without* the picker
    // footer in the same chunk — that's the user having dismissed the
    // picker (selected or cancelled) and Claude moving on.
    const pickerInChunk = chunkContainsClaudePickerFooter(data)
    if (pickerInChunk) this.claudePickerActive.add(sessionId)
    else if (oscState) this.claudePickerActive.delete(sessionId)

    const state: ClaudeWorkState | null =
      this.claudePickerActive.has(sessionId) ? 'waitingUserInput' : oscState

    if (!state) return

    // `✳` doubles as a working-spinner frame, so an idle title is a claim, not
    // a fact: hold it and let a following spinner frame retract it. Without
    // this every mid-turn ✳ became a working→idle edge — a "Finished" toast on
    // a running agent, and (via the claude-osc override in the hook listener) a
    // forged idle state that the phone's own settle gate then confirmed.
    if (state === 'idle') {
      if (this.claudeWorkState.get(sessionId) === 'idle') return
      if (this.claudePendingIdle.has(sessionId)) return
      const timer = setTimeout(() => {
        this.claudePendingIdle.delete(sessionId)
        this.commitClaudeWorkState(sessionId, 'idle')
      }, CLAUDE_IDLE_SETTLE_MS)
      timer.unref?.()
      this.claudePendingIdle.set(sessionId, timer)
      return
    }

    this.cancelPendingClaudeIdle(sessionId)
    this.commitClaudeWorkState(sessionId, state)
  }

  private cancelPendingClaudeIdle(sessionId: string): void {
    const timer = this.claudePendingIdle.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.claudePendingIdle.delete(sessionId)
  }

  private commitClaudeWorkState(sessionId: string, state: ClaudeWorkState): void {
    if (!this.window || this.window.isDestroyed()) return

    const prevState = this.claudeWorkState.get(sessionId)
    if (prevState === state) return

    this.claudeWorkState.set(sessionId, state)
    console.log(`[claude-work] session=${sessionId.slice(0, 8)} state=${state}`)
    this.claudeWorkStateHandler?.(sessionId, state)
    for (const h of this.claudeWorkStateSubscribers) h(sessionId, state)
    this.window.webContents.send('claude-work-state', sessionId, state)

    if (state === 'working') {
      markWorkingStart(sessionId)
      noteAgentWorking(sessionId)
    }

    if (prevState === 'working' && state === 'idle') {
      import('./idle-notifier').then(({ notifyIdleTransition }) => {
        notifyIdleTransition(sessionId, 'claude').catch(() => {})
      }).catch(() => {})
    }

    // Picker → waitingUserInput is the moment Claude is blocked on the user.
    // Fire an idle-notification with the picker source so the renderer
    // surfaces the toast even though Claude's OSC title may still say
    // 'working' (this bypasses the working-guard in useIdleNotifications).
    if (prevState !== 'waitingUserInput' && state === 'waitingUserInput') {
      import('./idle-notifier').then(({ notifyIdleTransition }) => {
        notifyIdleTransition(sessionId, 'claude', undefined, undefined, false, true).catch(() => {})
      }).catch(() => {})
    }
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

  getClaudeWorkState(sessionId: string): ClaudeWorkState | null {
    return this.claudeWorkState.get(sessionId) ?? null
  }

  /**
   * Feed the title scraper for Claude sessions this client never attached (see
   * `titleTaps`). Called on every process-monitor tick with the sessions
   * currently running claude. Starts at the stream head — old titles would
   * replay stale edges — and reseeds there after a gap.
   */
  async pollTitleTaps(claudeSessionIds: string[]): Promise<void> {
    const wanted = new Set(claudeSessionIds.filter((id) => !this.attachedSessions.has(id)))
    for (const id of this.titleTaps.keys()) {
      if (!wanted.has(id)) this.titleTaps.delete(id)
    }
    if (!this.supportsTerminalStream()) return
    await Promise.all([...wanted].map((id) => this.pollTitleTap(id)))
  }

  private async pollTitleTap(sessionId: string): Promise<void> {
    const tap = this.titleTaps.get(sessionId)
    if (tap?.busy) return
    try {
      if (!tap) {
        const head = await this.getTerminalStreamCheckpoint(sessionId)
        if (this.attachedSessions.has(sessionId)) return
        this.titleTaps.set(sessionId, { epoch: head.epoch, seq: head.seq, offset: head.offset, decoder: new TextDecoder(), busy: false })
        return
      }
      tap.busy = true
      // Drain a burst (a full repaint can exceed one read window) so an idle
      // title isn't seen a tick late per window.
      for (let reads = 0; reads < 8; reads++) {
        const read = await this.readTerminalStream(sessionId, tap.epoch, tap.seq, 64 * 1024, tap.offset)
        if (this.titleTaps.get(sessionId) !== tap) return
        if (read.gap) {
          this.titleTaps.delete(sessionId)
          this.claudeTitleRemainder.delete(sessionId)
          return
        }
        if (read.frames.length === 0) return
        let text = ''
        for (const encoded of read.frames) {
          const frame = decodeFrame(Buffer.from(encoded, 'base64'))
          tap.seq = String(frame.seq)
          tap.offset = String(frame.offset)
          if (frame.kind === 'output') text += tap.decoder.decode(frame.payload, { stream: true })
        }
        if (text) this.processClaudeWorkState(sessionId, text)
      }
    } catch {
      // Session gone or daemon busy — the next tick reseeds.
      this.titleTaps.delete(sessionId)
    } finally {
      if (tap) tap.busy = false
    }
  }
}

// Singleton
let client: DaemonClient | null = null

export function getDaemonClient(): DaemonClient {
  if (!client) client = new DaemonClient()
  return client
}
