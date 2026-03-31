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
import {
  DEFAULT_WARM_SHELL_POOL_SIZE,
  countWarmShellCapacity,
  getAdaptiveWarmShellPoolSize,
  pickWarmShellForClaim,
  pruneWarmShellPool,
  shouldReuseWarmShell,
  trimBurstClaimTimestamps,
  WARM_SHELL_BURST_WINDOW_MS,
  WARM_SHELL_IDLE_TTL_MS,
} from './warm-shell-pool'
import {
  buildWarmAgentPoolKey,
  DEFAULT_WARM_AGENT_POOL_SIZE,
  getWarmAgentKindForCommand,
  isWarmAgentPoolEnabled,
  WARM_AGENT_IDLE_TTL_MS,
  type WarmAgentKind,
} from './warm-agent-pool'
import {
  CLAUDE_INTERACTIVE_COMMAND_PREVIEW,
  CODEX_INTERACTIVE_COMMAND_PREVIEW,
} from '../shared/action-utils'

interface SessionRequest {
  sessionId: string
  cwd: string
  cols: number
  rows: number
  env?: Record<string, string>
  initialCommand?: string
  launchProfile?: TerminalLaunchProfile
}

interface WarmAgentSpec extends Omit<SessionRequest, 'sessionId' | 'launchProfile'> {
  kind: WarmAgentKind
}

class TerminalHost {
  private sessions = new Map<string, Session>()
  private warmShells = new Map<string, Session[]>()
  private warmAgents = new Map<string, Session[]>()
  private warmShellSpecs = new Map<string, Omit<SessionRequest, 'sessionId' | 'initialCommand' | 'launchProfile'>>()
  private warmAgentSpecs = new Map<string, WarmAgentSpec>()
  private warmShellClaims = new Map<string, number[]>()
  private warmShellDecayTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private warmShellIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private warmShellFailures = new Map<string, number>()
  private warmShellBackoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private warmAgentFailures = new Map<string, number>()
  private warmAgentBackoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private warmAgentIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private static readonly MAX_TOTAL_PTY_PROCESSES = 20

  private totalPtyCount(): number {
    let count = this.sessions.size
    for (const sessions of this.warmShells.values()) count += sessions.length
    for (const sessions of this.warmAgents.values()) count += sessions.length
    return count
  }

  private warmShellKey(cwd: string): string {
    return cwd
  }

  private warmAgentKey(cwd: string, kind: WarmAgentKind): string {
    return buildWarmAgentPoolKey(cwd, kind)
  }

  private getWarmAgentInitialCommand(kind: WarmAgentKind): string {
    return kind === 'claude'
      ? CLAUDE_INTERACTIVE_COMMAND_PREVIEW
      : CODEX_INTERACTIVE_COMMAND_PREVIEW
  }

  private createSession(request: SessionRequest, persistHistory = true, suppressSessionIdEnv = false): Session {
    const session = new Session({
      sessionId: request.sessionId,
      processSessionId: request.sessionId,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      initialCommand: request.initialCommand,
      launchProfile: request.launchProfile,
      persistHistory,
      suppressSessionIdEnv,
    })

    session.spawn({
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env
    })

    return session
  }

  private createWarmAgentSession(spec: WarmAgentSpec): Session {
    const sessionId = `__warm-agent__:${spec.kind}:${crypto.randomUUID()}`
    const session = new Session({
      sessionId,
      processSessionId: sessionId,
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      initialCommand: spec.initialCommand,
      launchProfile: { kind: 'shell' },
      persistHistory: false,
      suppressSessionIdEnv: false,
    })

    session.spawn({
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
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

  private setWarmShells(key: string, sessions: Session[]): void {
    if (sessions.length > 0) {
      this.warmShells.set(key, sessions)
      return
    }

    this.warmShells.delete(key)
  }

  private pruneWarmShells(key: string): Session[] {
    const active = pruneWarmShellPool(this.warmShells.get(key) ?? [])
    this.setWarmShells(key, active)
    return active
  }

  private getWarmShellClaimTimestamps(key: string, now = Date.now()): number[] {
    const trimmed = trimBurstClaimTimestamps(this.warmShellClaims.get(key) ?? [], now)
    if (trimmed.length > 0) {
      this.warmShellClaims.set(key, trimmed)
    } else {
      this.warmShellClaims.delete(key)
    }
    return trimmed
  }

  private getWarmShellTargetSize(key: string, now = Date.now()): number {
    const claimTimestamps = this.getWarmShellClaimTimestamps(key, now)
    return claimTimestamps.length > 0
      ? getAdaptiveWarmShellPoolSize(claimTimestamps, now)
      : DEFAULT_WARM_SHELL_POOL_SIZE
  }

  private scheduleWarmShellDecay(key: string): void {
    const existingTimer = this.warmShellDecayTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.warmShellDecayTimers.delete(key)
    }

    const claimTimestamps = this.getWarmShellClaimTimestamps(key)
    if (claimTimestamps.length === 0) return

    const nextExpiryAt = claimTimestamps[0] + WARM_SHELL_BURST_WINDOW_MS
    const delay = Math.max(nextExpiryAt - Date.now(), 0)
    const timer = setTimeout(() => {
      this.warmShellDecayTimers.delete(key)
      this.getWarmShellClaimTimestamps(key)
      this.ensureWarmShellPool(key)
      this.scheduleWarmShellDecay(key)
    }, delay)

    this.warmShellDecayTimers.set(key, timer)
  }

  private recordWarmShellClaim(key: string): void {
    const now = Date.now()
    const claims = [...this.getWarmShellClaimTimestamps(key, now), now]
    this.warmShellClaims.set(key, claims)
    this.scheduleWarmShellDecay(key)
    this.scheduleWarmShellIdleExpiry(key)
  }

  private scheduleWarmShellIdleExpiry(key: string): void {
    const existingTimer = this.warmShellIdleTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.warmShellIdleTimers.delete(key)
    }

    const timer = setTimeout(() => {
      this.warmShellIdleTimers.delete(key)
      this.disposeWarmShellPool(key)
    }, WARM_SHELL_IDLE_TTL_MS)

    this.warmShellIdleTimers.set(key, timer)
  }

  private disposeWarmShellPool(key: string): void {
    const sessions = this.warmShells.get(key) ?? []
    for (const session of sessions) {
      session.dispose()
    }
    this.warmShells.delete(key)
    this.warmShellSpecs.delete(key)
    this.warmShellClaims.delete(key)
    this.warmShellFailures.delete(key)

    const decayTimer = this.warmShellDecayTimers.get(key)
    if (decayTimer) {
      clearTimeout(decayTimer)
      this.warmShellDecayTimers.delete(key)
    }

    const backoffTimer = this.warmShellBackoffTimers.get(key)
    if (backoffTimer) {
      clearTimeout(backoffTimer)
      this.warmShellBackoffTimers.delete(key)
    }
  }

  private scheduleWarmAgentIdleExpiry(key: string): void {
    const existingTimer = this.warmAgentIdleTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.warmAgentIdleTimers.delete(key)
    }

    const timer = setTimeout(() => {
      this.warmAgentIdleTimers.delete(key)
      this.disposeWarmAgentPool(key)
    }, WARM_AGENT_IDLE_TTL_MS)

    this.warmAgentIdleTimers.set(key, timer)
  }

  private disposeWarmAgentPool(key: string): void {
    const sessions = this.warmAgents.get(key) ?? []
    for (const session of sessions) {
      session.dispose()
    }
    this.warmAgents.delete(key)
    this.warmAgentSpecs.delete(key)
    this.warmAgentFailures.delete(key)

    const backoffTimer = this.warmAgentBackoffTimers.get(key)
    if (backoffTimer) {
      clearTimeout(backoffTimer)
      this.warmAgentBackoffTimers.delete(key)
    }
  }

  private ensureWarmShellPool(key: string): void {
    const spec = this.warmShellSpecs.get(key)
    if (!spec) return

    // Hard cap: refuse to spawn if we've hit the global process limit
    if (this.totalPtyCount() >= TerminalHost.MAX_TOTAL_PTY_PROCESSES) return

    // Circuit breaker: stop spawning after consecutive failures
    const failures = this.warmShellFailures.get(key) ?? 0
    if (failures >= 3) {
      // Already have a backoff timer scheduled, don't spawn
      if (this.warmShellBackoffTimers.has(key)) return
      // Schedule retry with exponential backoff (10s, 20s, 40s, ... capped at 5min)
      const delay = Math.min(10_000 * Math.pow(2, failures - 3), 300_000)
      console.warn(`[daemon] Warm shell pool for ${key}: ${failures} consecutive failures, retrying in ${delay / 1000}s`)
      const timer = setTimeout(() => {
        this.warmShellBackoffTimers.delete(key)
        this.warmShellFailures.set(key, 0)
        this.ensureWarmShellPool(key)
      }, delay)
      this.warmShellBackoffTimers.set(key, timer)
      return
    }

    const targetSize = this.getWarmShellTargetSize(key)
    let nextSessions = this.pruneWarmShells(key)
    for (const session of nextSessions) {
      try {
        session.resize(spec.cols, spec.rows)
      } catch {}
    }

    while (countWarmShellCapacity(nextSessions) > targetSize) {
      const session = nextSessions.pop()
      if (!session) break
      session.dispose()
    }

    while (countWarmShellCapacity(nextSessions) < targetSize && this.totalPtyCount() < TerminalHost.MAX_TOTAL_PTY_PROCESSES) {
      const spawnedAt = Date.now()
      const session = this.createSession({
        sessionId: `__warm__:${crypto.randomUUID()}`,
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
        env: spec.env,
        launchProfile: { kind: 'shell' },
      }, false, true)

      session.onExit(() => {
        const active = (this.warmShells.get(key) ?? []).filter((tracked) => tracked !== session)
        this.setWarmShells(key, active)
        session.dispose()

        // Track rapid failures (died within 5s of spawn)
        if (Date.now() - spawnedAt < 5_000) {
          this.warmShellFailures.set(key, (this.warmShellFailures.get(key) ?? 0) + 1)
        } else {
          this.warmShellFailures.set(key, 0)
        }

        this.ensureWarmShellPool(key)
      })

      nextSessions = [...nextSessions, session]
    }

    this.setWarmShells(key, nextSessions)
  }

  private setWarmAgents(key: string, sessions: Session[]): void {
    if (sessions.length > 0) {
      this.warmAgents.set(key, sessions)
      return
    }

    this.warmAgents.delete(key)
  }

  private pruneWarmAgents(key: string): Session[] {
    const active = pruneWarmShellPool(this.warmAgents.get(key) ?? [])
    this.setWarmAgents(key, active)
    return active
  }

  private ensureWarmAgentPool(key: string): void {
    if (!isWarmAgentPoolEnabled()) return
    const spec = this.warmAgentSpecs.get(key)
    if (!spec) return

    // Hard cap: refuse to spawn if we've hit the global process limit
    if (this.totalPtyCount() >= TerminalHost.MAX_TOTAL_PTY_PROCESSES) return

    const failures = this.warmAgentFailures.get(key) ?? 0
    if (failures >= 3) {
      if (this.warmAgentBackoffTimers.has(key)) return
      const delay = Math.min(10_000 * Math.pow(2, failures - 3), 300_000)
      console.warn(`[daemon] Warm agent pool for ${key}: ${failures} consecutive failures, retrying in ${delay / 1000}s`)
      const timer = setTimeout(() => {
        this.warmAgentBackoffTimers.delete(key)
        this.warmAgentFailures.set(key, 0)
        this.ensureWarmAgentPool(key)
      }, delay)
      this.warmAgentBackoffTimers.set(key, timer)
      return
    }

    let nextSessions = this.pruneWarmAgents(key)
    for (const session of nextSessions) {
      try {
        session.resize(spec.cols, spec.rows)
      } catch {}
    }

    while (countWarmShellCapacity(nextSessions) > DEFAULT_WARM_AGENT_POOL_SIZE) {
      const session = nextSessions.pop()
      if (!session) break
      session.dispose()
    }

    while (countWarmShellCapacity(nextSessions) < DEFAULT_WARM_AGENT_POOL_SIZE && this.totalPtyCount() < TerminalHost.MAX_TOTAL_PTY_PROCESSES) {
      const spawnedAt = Date.now()
      const session = this.createWarmAgentSession(spec)

      session.onExit(() => {
        const active = (this.warmAgents.get(key) ?? []).filter((tracked) => tracked !== session)
        this.setWarmAgents(key, active)
        session.dispose()

        if (Date.now() - spawnedAt < 5_000) {
          this.warmAgentFailures.set(key, (this.warmAgentFailures.get(key) ?? 0) + 1)
        } else {
          this.warmAgentFailures.set(key, 0)
        }

        this.ensureWarmAgentPool(key)
      })

      nextSessions = [...nextSessions, session]
    }

    this.setWarmAgents(key, nextSessions)
  }

  private claimWarmShell(request: SessionRequest): Session | undefined {
    const key = this.warmShellKey(request.cwd)
    this.scheduleWarmShellIdleExpiry(key)
    const sessions = this.pruneWarmShells(key)
    const claimIndex = pickWarmShellForClaim(sessions)
    if (claimIndex < 0) return undefined

    const session = sessions[claimIndex]
    if (!session) return undefined

    const remaining = sessions.filter((_, index) => index !== claimIndex)
    this.setWarmShells(key, remaining)

    if (!session.isAttachable) {
      session.dispose()
      return undefined
    }

    session.claim({
      sessionId: request.sessionId,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env,
      initialCommand: request.initialCommand,
      launchProfile: request.launchProfile
    })

    this.ensureWarmShellPool(key)

    return session
  }

  private claimWarmAgent(request: SessionRequest): Session | undefined {
    if (!isWarmAgentPoolEnabled()) return undefined
    const kind = getWarmAgentKindForCommand(request.initialCommand)
    if (!kind) return undefined

    const key = this.warmAgentKey(request.cwd, kind)
    this.scheduleWarmAgentIdleExpiry(key)
    const sessions = this.pruneWarmAgents(key)
    const claimIndex = sessions.findIndex((session) => session.isAttachable && session.isReadyForReuse)
    if (claimIndex < 0) return undefined

    const session = sessions[claimIndex]
    if (!session) return undefined

    const remaining = sessions.filter((_, index) => index !== claimIndex)
    this.setWarmAgents(key, remaining)

    if (!session.isAttachable) {
      session.dispose()
      return undefined
    }

    const processSessionId = session.envSessionId
    session.claim({
      sessionId: request.sessionId,
      processSessionId,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env,
      initialCommand: undefined,
      launchProfile: { kind: 'shell' },
      reuseRunningProcess: true,
    })

    this.ensureWarmAgentPool(key)

    return session
  }

  prewarmShell(request: Omit<SessionRequest, 'sessionId' | 'initialCommand' | 'launchProfile'>): void {
    const key = this.warmShellKey(request.cwd)
    this.scheduleWarmShellIdleExpiry(key)
    this.warmShellSpecs.set(key, {
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: request.env,
    })
    this.ensureWarmShellPool(key)

    if (!isWarmAgentPoolEnabled()) return

    for (const kind of ['claude', 'codex'] as const) {
      const agentKey = this.warmAgentKey(request.cwd, kind)
      this.scheduleWarmAgentIdleExpiry(agentKey)
      this.warmAgentSpecs.set(agentKey, {
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        env: request.env,
        kind,
        initialCommand: this.getWarmAgentInitialCommand(kind),
      })
      this.ensureWarmAgentPool(agentKey)
    }
  }

  createOrAttach(request: SessionRequest): { isNew: boolean; snapshot: SessionSnapshot | null; pid: number | null; processSessionId: string } {
    let session: Session | undefined = this.sessions.get(request.sessionId)
    let isNew = false
    const warmShellKey = this.warmShellKey(request.cwd)

    if (session?.isTerminating) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }
    if (session?.isSuspended) {
      session.resume()
    } else if (session && !session.isAlive) {
      session.dispose()
      this.sessions.delete(request.sessionId)
      session = undefined
    }

    if (!session) {
      session = this.claimWarmAgent(request)
      if (!session && shouldReuseWarmShell(request.launchProfile)) {
        session = this.claimWarmShell(request)
      }
      if (!session) {
        session = this.createSession(request)
      }

      this.configureActiveSession(session)
      this.sessions.set(request.sessionId, session)
      isNew = true

      if (shouldReuseWarmShell(request.launchProfile)) {
        this.recordWarmShellClaim(warmShellKey)
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

    return {
      isNew,
      snapshot: null,
      pid: session.pid,
      processSessionId: session.envSessionId,
    }
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

  suspend(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.suspend()
  }

  signal(sessionId: string, sig: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.isAttachable) session.sendSignal(sig)
  }

  detach(sessionId: string, socket: net.Socket): void {
    const session = this.sessions.get(sessionId)
    if (session) session.detach(socket)
  }

  listSessions(): { sessionId: string; processSessionId: string; pid: number | null; cwd: string; isAlive: boolean }[] {
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
      for (const warmSession of session) {
        warmSession.dispose()
      }
    }
    this.warmShells.clear()
    for (const session of this.warmAgents.values()) {
      for (const warmSession of session) {
        warmSession.dispose()
      }
    }
    this.warmAgents.clear()
    this.warmShellSpecs.clear()
    this.warmAgentSpecs.clear()
    this.warmShellClaims.clear()
    for (const timer of this.warmShellDecayTimers.values()) clearTimeout(timer)
    this.warmShellDecayTimers.clear()
    for (const timer of this.warmShellIdleTimers.values()) clearTimeout(timer)
    this.warmShellIdleTimers.clear()
    for (const timer of this.warmShellBackoffTimers.values()) clearTimeout(timer)
    this.warmShellBackoffTimers.clear()
    this.warmShellFailures.clear()
    for (const timer of this.warmAgentBackoffTimers.values()) clearTimeout(timer)
    this.warmAgentBackoffTimers.clear()
    for (const timer of this.warmAgentIdleTimers.values()) clearTimeout(timer)
    this.warmAgentIdleTimers.clear()
    this.warmAgentFailures.clear()
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

/**
 * Wait for the stream socket to appear for a given clientId.
 * This handles the race where createOrAttach arrives on the control socket
 * before the stream socket's hello has been processed by the event loop.
 */
function waitForStream(clientId: string, timeoutMs = 500): Promise<net.Socket | null> {
  const existing = streamByClientId.get(clientId)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const stream = streamByClientId.get(clientId)
      if (stream) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve(stream)
      }
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(interval)
      resolve(null)
    }, timeoutMs)
  })
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

        // Attach stream socket — may need to wait briefly for the stream
        // socket's hello to be processed (cross-socket race condition)
        const stream = state.clientId
          ? (getStreamForClient(state.clientId) ?? await waitForStream(state.clientId))
          : null
        let snapshot: SessionSnapshot | null = null
        if (stream) {
          snapshot = await host.attachStream(msg.sessionId, stream)
        } else if (state.clientId) {
          console.warn(`[daemon] No stream socket for client ${state.clientId} on createOrAttach`)
        }

        if (msg.id != null) {
          sendJson(socket, {
            id: msg.id,
            ok: true,
            isNew: result.isNew,
            pid: result.pid,
            processSessionId: result.processSessionId,
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

    case 'suspend': {
      host.suspend(msg.sessionId)
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
