// src/daemon/daemon.ts
// Persistent terminal daemon — runs outside Electron as a detached Node.js process.
// Listens on Unix domain socket, manages terminal sessions.

import * as net from 'node:net'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH, DAEMON_META_PATH, SNAPSHOTS_DIR,
  sendJson, createJsonParser,
  DaemonRequest, SessionSnapshot
} from './protocol'
import { Session } from './session'
import { PromptHistoryWriter } from './prompt-history-writer'
import type { TerminalLaunchProfile } from '../shared/types'

interface SessionRequest {
  sessionId: string
  cwd: string
  cols: number
  rows: number
  env?: Record<string, string>
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
}

class TerminalHost {
  private sessions = new Map<string, Session>()
  private warmShells = new Map<string, Session>()
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private warmShellKey(cwd: string): string {
    return cwd
  }

  private isDirectExec(launchProfile?: TerminalLaunchProfile): boolean {
    return launchProfile?.kind === 'exec'
  }

  private shouldReuseWarmShell(request: SessionRequest): boolean {
    return !request.initialCommand && !this.isDirectExec(request.launchProfile)
  }

  private createSession(request: SessionRequest, persistHistory = true): Session {
    const session = new Session({
      sessionId: request.sessionId,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      initialCommand: request.initialCommand,
      launchProfile: request.launchProfile,
      persistHistory
    })

    session.spawn({
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env
    })

    return session
  }

  private configureActiveSession(session: Session): void {
    session.onExit((id) => {
      this.removeSnapshot(id)
      session.cleanupHistory()
      setTimeout(() => {
        const tracked = this.sessions.get(id)
        if (tracked === session && !tracked.isAlive) {
          tracked.dispose()
          this.sessions.delete(id)
        }
      }, 5000)
    })
  }

  private claimWarmShell(request: SessionRequest): Session | undefined {
    const key = this.warmShellKey(request.cwd)
    const session = this.warmShells.get(key)
    if (!session) return undefined

    if (!session.isAttachable) {
      this.warmShells.delete(key)
      session.dispose()
      return undefined
    }
    if (!session.isReadyForReuse) {
      return undefined
    }

    this.warmShells.delete(key)

    session.claim({
      sessionId: request.sessionId,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      initialCommand: request.initialCommand,
      launchProfile: request.launchProfile
    })

    return session
  }

  prewarmShell(request: Omit<SessionRequest, 'sessionId' | 'initialCommand' | 'launchProfile'>): void {
    const key = this.warmShellKey(request.cwd)
    const existing = this.warmShells.get(key)
    if (existing?.isAttachable) {
      existing.resize(request.cols, request.rows)
      return
    }
    if (existing) {
      existing.dispose()
      this.warmShells.delete(key)
    }

    const session = this.createSession({
      sessionId: `__warm__:${crypto.randomUUID()}`,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env,
      launchProfile: { kind: 'shell' }
    }, false)

    session.onExit(() => {
      const tracked = this.warmShells.get(key)
      if (tracked === session) {
        tracked.dispose()
        this.warmShells.delete(key)
      }
    })

    this.warmShells.set(key, session)
  }

  createOrAttach(request: SessionRequest): { isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null } {
    let session: Session | undefined = this.sessions.get(request.sessionId)
    let isNew = false

    if (session?.isTerminating) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }
    if (session && !session.isAlive) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }

    if (!session) {
      session = this.shouldReuseWarmShell(request) ? this.claimWarmShell(request) : undefined
      if (!session) {
        session = this.createSession(request)
      }

      this.configureActiveSession(session)
      this.sessions.set(request.sessionId, session)
      isNew = true

      if (this.shouldReuseWarmShell(request)) {
        this.prewarmShell({
          cwd: request.cwd,
          cols: request.cols,
          rows: request.rows,
          env: request.env
        })
      }
    } else {
      try { session.resize(request.cols, request.rows) } catch {}
    }

    return { isNew, snapshot: null, pid: session.pid }
  }

  async attachStream(sessionId: string, socket: net.Socket): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAttachable) return null
    return session.attach(socket)
  }

  write(sessionId: string, data: string, source: 'user' | 'system' = 'user'): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.write(data, source)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.resize(cols, rows)
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.kill()

    // Fail-safe cleanup
    if (!this.killTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        const s = this.sessions.get(sessionId)
        if (s?.isTerminating) {
          s.dispose()
          this.sessions.delete(sessionId)
        }
        this.killTimers.delete(sessionId)
      }, 5000)
      this.killTimers.set(sessionId, timer)
    }
  }

  signal(sessionId: string, sig: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.sendSignal(sig)
  }

  detach(sessionId: string, socket: net.Socket): void {
    const session = this.sessions.get(sessionId)
    if (session) session.detach(socket)
  }

  listSessions(): { sessionId: string; pid: number | null; cwd: string; isAlive: boolean }[] {
    return Array.from(this.sessions.values()).map((s) => s.getMeta())
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAttachable) return null
    return session.getSnapshotAsync()
  }

  saveAllSnapshots(): void {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true })
    for (const session of this.sessions.values()) {
      try {
        if (!session.isAlive) continue
        const snapshot = session.getSnapshot()
        const filePath = `${SNAPSHOTS_DIR}/${session.sessionId}.json`
        fs.writeFileSync(filePath, JSON.stringify(snapshot))
      } catch (err) {
        console.error(`[daemon] Failed to save snapshot for ${session.sessionId}:`, err)
      }
    }
  }

  removeSnapshot(sessionId: string): void {
    try { fs.unlinkSync(`${SNAPSHOTS_DIR}/${sessionId}.json`) } catch {}
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose()
    }
    this.sessions.clear()
    for (const session of this.warmShells.values()) {
      session.dispose()
    }
    this.warmShells.clear()
    for (const timer of this.killTimers.values()) clearTimeout(timer)
    this.killTimers.clear()
  }
}

// Automation runner for persistent automations
interface DaemonAutomation {
  actionId: string
  workspaceId: string
  command: string
  cwd: string
  nextRunAt: number
  schedule: any
  lastRunAt: number
}

interface DaemonAutomationRun {
  id: string
  actionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string
  exitCode?: number
  errorMessage?: string
  triggeredBy: 'schedule'
}

class AutomationRunner {
  private automations: DaemonAutomation[] = []
  private runs: DaemonAutomationRun[] = []
  private running = new Set<string>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private runsPath = DAEMON_DIR + '/automation-runs.json'

  handoff(automations: DaemonAutomation[]): void {
    this.automations = automations
    this.loadRuns()
    if (!this.ticker) {
      this.ticker = setInterval(() => this.tick(), 30_000)
    }
  }

  reclaim(): DaemonAutomationRun[] {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    const runs = [...this.runs]
    this.runs = []
    this.automations = []
    this.saveRuns()
    return runs
  }

  sync(): DaemonAutomationRun[] {
    return [...this.runs]
  }

  private tick(): void {
    const now = Date.now()
    for (const auto of this.automations) {
      if (auto.nextRunAt > now) continue
      if (this.running.has(auto.actionId)) continue
      this.execute(auto)
    }
  }

  private execute(auto: DaemonAutomation): void {
    this.running.add(auto.actionId)
    const shell = process.env.SHELL || '/bin/sh'
    const run: DaemonAutomationRun = {
      id: crypto.randomUUID(),
      actionId: auto.actionId,
      workspaceId: auto.workspaceId,
      startedAt: Date.now(),
      status: 'running',
      output: '',
      triggeredBy: 'schedule',
    }

    const child = spawn(shell, ['-l', '-c', auto.command], {
      cwd: auto.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 1024 * 1024) {
        output = output.slice(0, 1024 * 1024) + '\n[output truncated]'
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const timeout = setTimeout(() => child.kill('SIGTERM'), 30 * 60_000)

    child.on('close', (code) => {
      clearTimeout(timeout)
      this.running.delete(auto.actionId)
      run.finishedAt = Date.now()
      run.output = output
      run.exitCode = code ?? undefined
      run.status = code === 0 ? 'success' : 'error'
      if (run.status === 'error' && !run.errorMessage) {
        run.errorMessage = code === null
          ? 'Process was killed (timeout or signal)'
          : `Process exited with code ${code}`
      }
      this.runs.push(run)
      this.saveRuns()

      // Recompute nextRunAt
      const now = Date.now()
      const schedule = auto.schedule
      if (schedule?.mode === 'interval') {
        auto.nextRunAt = now + (schedule.intervalMinutes ?? 60) * 60_000
      } else if (schedule?.mode === 'daily') {
        auto.nextRunAt = now + 86400_000
      }
      auto.lastRunAt = now
    })
  }

  private loadRuns(): void {
    try {
      if (fs.existsSync(this.runsPath)) {
        this.runs = JSON.parse(fs.readFileSync(this.runsPath, 'utf8'))
      }
    } catch { this.runs = [] }
  }

  private saveRuns(): void {
    try {
      fs.writeFileSync(this.runsPath, JSON.stringify(this.runs))
    } catch {}
  }
}

// Socket server
const host = new TerminalHost()
const automationRunner = new AutomationRunner()

// Track client state: which socket is control vs stream
interface ClientState {
  role: 'control' | 'stream' | null
  streamSocket: net.Socket | null
  controlSocket: net.Socket | null
  clientId: string | null
}

const clientStates = new Map<net.Socket, ClientState>()
// Map clientId -> stream socket for pairing
const streamByClientId = new Map<string, net.Socket>()
const controlByClientId = new Map<string, net.Socket>()

function getStreamForClient(clientId: string): net.Socket | null {
  return streamByClientId.get(clientId) || null
}

async function handleMessage(socket: net.Socket, msg: DaemonRequest): Promise<void> {
  const state = clientStates.get(socket)!

  if (msg.type === 'hello') {
    state.role = msg.role
    state.clientId = msg.clientId
    if (msg.role === 'stream') {
      streamByClientId.set(msg.clientId, socket)
    } else if (msg.role === 'control') {
      controlByClientId.set(msg.clientId, socket)
    }
    if (msg.id != null) {
      sendJson(socket, { id: msg.id, ok: true })
    }
    return
  }

  // All other messages require control role
  if (state.role !== 'control') return

  switch (msg.type) {
    case 'createOrAttach': {
      try {
        const result = host.createOrAttach({
          sessionId: msg.sessionId,
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          env: msg.env,
          initialCommand: msg.initialCommand,
          launchProfile: msg.launchProfile
        })

        // Attach stream socket
        const stream = state.clientId ? getStreamForClient(state.clientId) : null
        let snapshot: SessionSnapshot | null = null
        if (stream) {
          snapshot = await host.attachStream(msg.sessionId, stream)
        }

        if (msg.id != null) {
          sendJson(socket, {
            id: msg.id,
            ok: true,
            isNew: result.isNew,
            pid: result.pid,
            snapshot
          })
        }
      } catch (err: any) {
        console.error(`[daemon] createOrAttach error:`, err)
        if (msg.id != null) {
          sendJson(socket, { id: msg.id, ok: false, error: err.message })
        }
      }
      break
    }

    case 'prewarmShell': {
      host.prewarmShell({
        cwd: msg.cwd,
        cols: msg.cols,
        rows: msg.rows,
        env: msg.env
      })
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'write': {
      host.write(msg.sessionId, msg.data, msg.source || 'user')
      // Fire-and-forget, no response unless id present
      if (msg.id != null && typeof msg.id === 'number') {
        sendJson(socket, { id: msg.id, ok: true })
      }
      break
    }

    case 'resize': {
      host.resize(msg.sessionId, msg.cols, msg.rows)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'kill': {
      host.kill(msg.sessionId)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'signal': {
      host.signal(msg.sessionId, msg.signal)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'detach': {
      const stream = state.clientId ? getStreamForClient(state.clientId) : null
      if (stream) host.detach(msg.sessionId, stream)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'listSessions': {
      const sessions = host.listSessions()
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, sessions })
      break
    }

    case 'getPromptHistory': {
      const records = PromptHistoryWriter.readHistory(msg.sessionId)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, records })
      break
    }

    case 'getSnapshot': {
      const snapshot = await host.getSessionSnapshot(msg.sessionId)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, snapshot })
      break
    }

    case 'automation-handoff': {
      automationRunner.handoff(msg.automations ?? [])
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true })
      break
    }

    case 'automation-sync': {
      const runs = automationRunner.sync()
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, runs })
      break
    }

    case 'automation-reclaim': {
      const reclaimedRuns = automationRunner.reclaim()
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, runs: reclaimedRuns })
      break
    }
  }
}

// Create server
mkdirSync(DAEMON_DIR, { recursive: true })

// Remove stale socket
try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}

const server = net.createServer((socket) => {
  clientStates.set(socket, { role: null, clientId: null, streamSocket: null, controlSocket: null })

  const parse = createJsonParser((msg) => handleMessage(socket, msg))
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => parse(chunk))

  socket.on('close', () => {
    const state = clientStates.get(socket)
    if (state?.clientId) {
      if (state.role === 'stream') {
        streamByClientId.delete(state.clientId)
        // Detach this socket from all sessions
        for (const session of host.listSessions()) {
          host.detach(session.sessionId, socket)
        }
      }
      if (state.role === 'control') {
        controlByClientId.delete(state.clientId)
      }
    }
    clientStates.delete(socket)
  })

  socket.on('error', () => {
    socket.destroy()
  })
})

server.listen(DAEMON_SOCKET_PATH, () => {
  // Write PID file
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid))
  fs.writeFileSync(DAEMON_META_PATH, JSON.stringify({
    pid: process.pid,
    execPath: process.execPath,
    nodeExecPath: process.env.ORCHESTRA_NODE_EXEC_PATH || process.execPath,
    codeSignature: process.env.ORCHESTRA_DAEMON_CODE_SIGNATURE || null,
    startedAt: new Date().toISOString(),
  }))
  console.log(`[daemon] Listening on ${DAEMON_SOCKET_PATH} (PID ${process.pid})`)
})

// Periodically save snapshots to disk for cold restore (survives reboot)
const SNAPSHOT_INTERVAL_MS = 30_000
const snapshotTimer = setInterval(() => {
  host.saveAllSnapshots()
}, SNAPSHOT_INTERVAL_MS)

// Handle shutdown signals
function shutdown(): void {
  clearInterval(snapshotTimer)
  host.saveAllSnapshots()
  host.disposeAll()
  server.close()
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_META_PATH) } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
