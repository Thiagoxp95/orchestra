import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import { cleanForDisplay } from './claude-activity-parser'
import { getCodexAppServer, stopCodexAppServer } from './codex-app-server'
import { findCodexRolloutByDirectory } from './codex-rollout-files'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { getCodexWatchRegistrationDecision } from './codex-watch-registration'
import {
  extractLastCodexResponse,
  getCodexWorkState,
  getCodexWorkStateFromThread,
  pickAssignableCodexThreadId,
  wasCodexThreadUpdatedForProcess,
  type CodexThreadDetail,
  type CodexWorkState,
} from './codex-thread-state'
import { notifyIdleTransition } from './idle-notifier'
import { debugWorkState } from './work-state-debug'

export type { CodexWorkState }

interface CodexThreadSummary {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  path?: string | null
  source?: string
  status: {
    type: 'active' | 'idle' | 'notLoaded' | 'systemError'
    activeFlags?: string[]
  }
}

interface CodexThreadReadResponse {
  thread?: CodexThreadDetail | null
}

interface SessionEntry {
  sessionId: string
  cwd: string
  createdAt: number
  threadId: string | null
  bindingSource: 'pid' | 'heuristic' | null
  lastThreadUpdatedAt: number | null
  rolloutPath: string | null
  rolloutSize: number
  lastResponse: string
  lastWorkState: CodexWorkState
  codexPid: number | undefined
}

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')

const sessions = new Map<string, SessionEntry>()
const threadOwners = new Map<string, string>()

let mainWindow: BrowserWindow | null = null
let interval: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let tickQueued = false
let removeNotificationListener: (() => void) | null = null
let fsWatcher: fs.FSWatcher | null = null

function getProcessStartTimeMs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'etimes='], { timeout: 3000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null)
        return
      }

      const elapsedSeconds = Number.parseInt(stdout.trim(), 10)
      if (!Number.isFinite(elapsedSeconds)) {
        resolve(null)
        return
      }

      resolve(Date.now() - elapsedSeconds * 1000)
    })
  })
}

function startDirectoryWatch(): void {
  if (fsWatcher) return
  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
      fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true })
    }
    try {
      fsWatcher = fs.watch(CODEX_SESSIONS_DIR, { persistent: false, recursive: true }, () => {
        scheduleTick()
      })
    } catch {
      fsWatcher = fs.watch(CODEX_SESSIONS_DIR, { persistent: false }, () => {
        scheduleTick()
      })
    }
    fsWatcher.on('error', () => {
      stopDirectoryWatch()
    })
  } catch {}
}

function stopDirectoryWatch(): void {
  fsWatcher?.close()
  fsWatcher = null
}

function registerNotificationListener(): void {
  removeNotificationListener?.()
  removeNotificationListener = getCodexAppServer().onNotification((notification) => {
    const method = notification.method
    if (method !== 'turn/started' && method !== 'turn/completed') return

    const params = notification.params as { threadId?: string } | undefined
    const threadId = params?.threadId
    if (!threadId) return

    let matched = false
    for (const entry of sessions.values()) {
      if (entry.threadId !== threadId) continue
      matched = true

      if (method === 'turn/started') {
        emitWorkState(entry, 'working')
      } else {
        emitWorkState(entry, 'idle')
        void syncThreadRead(entry)
      }
    }

    if (!matched) {
      scheduleTick()
    }
  })
}

function scheduleTick(): void {
  if (tickInFlight) {
    tickQueued = true
    return
  }

  void tick()
}

function ensurePolling(): void {
  if (interval) return

  registerNotificationListener()
  startDirectoryWatch()

  // Pre-warm the codex app-server so it's ready for the first tick's API calls.
  void getCodexAppServer().request('thread/loaded/list', {}).catch(() => {})

  interval = setInterval(() => {
    scheduleTick()
  }, 3000)

  scheduleTick()
}

function maybeStopPolling(): void {
  if (sessions.size > 0) return
  if (interval) clearInterval(interval)
  interval = null
  stopDirectoryWatch()
  // App-server is intentionally kept warm to avoid cold-start delays.
}

function emitWorkState(
  entry: SessionEntry,
  nextState: CodexWorkState,
  options: { force?: boolean; notifyIdle?: boolean } = {}
): void {
  const prevState = entry.lastWorkState
  if (!options.force && prevState === nextState) return
  entry.lastWorkState = nextState
  debugWorkState('codex-work-state', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    threadId: entry.threadId,
    rolloutPath: entry.rolloutPath,
    state: nextState,
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-work-state', entry.sessionId, nextState)
  }
  if ((options.notifyIdle ?? true) && nextState === 'idle' && prevState !== 'idle') {
    void notifyIdleTransition(entry.sessionId, 'codex', entry.lastResponse || undefined)
  }
}

function emitLastResponse(entry: SessionEntry, response: string): void {
  const clean = cleanForDisplay(response)
  if (!clean || clean === entry.lastResponse) return
  entry.lastResponse = clean
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-last-response', entry.sessionId, clean)
  }
}

function clearLastResponse(entry: SessionEntry): void {
  if (!entry.lastResponse) return
  entry.lastResponse = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('codex-last-response', entry.sessionId, '')
  }
}

function releaseThread(entry: SessionEntry): void {
  if (!entry.threadId) return
  if (threadOwners.get(entry.threadId) === entry.sessionId) {
    threadOwners.delete(entry.threadId)
  }
  entry.threadId = null
  entry.bindingSource = null
  entry.lastThreadUpdatedAt = null
  entry.rolloutPath = null
  entry.rolloutSize = 0
}

function bindThread(
  entry: SessionEntry,
  threadId: string,
  rolloutPath: string | null,
  source: SessionEntry['bindingSource']
): boolean {
  // Prevent stealing a thread already owned by a different session
  const existingOwner = threadOwners.get(threadId)
  if (existingOwner && existingOwner !== entry.sessionId) {
    return false
  }

  const switchedThreads = entry.threadId != null && entry.threadId !== threadId
  if (switchedThreads) {
    releaseThread(entry)
    clearLastResponse(entry)
  }

  entry.threadId = threadId
  entry.bindingSource = source
  entry.rolloutPath = rolloutPath
  entry.rolloutSize = 0
  entry.lastThreadUpdatedAt = null
  threadOwners.set(threadId, entry.sessionId)
  return true
}

function getHeuristicAssignableThreads(entry: SessionEntry, threads: CodexThreadSummary[]): CodexThreadSummary[] {
  if (!entry.codexPid) return threads
  return threads.filter((thread) => wasCodexThreadUpdatedForProcess(thread, entry.createdAt))
}

function readRolloutState(entry: SessionEntry): void {
  if (!entry.rolloutPath) return

  try {
    const stat = fs.statSync(entry.rolloutPath)
    if (stat.size === entry.rolloutSize) return
    entry.rolloutSize = stat.size

    const text = fs.readFileSync(entry.rolloutPath, 'utf8')
    const parsed = parseCodexRolloutLines(text.split('\n'))
    emitWorkState(entry, parsed.workState)
    if (parsed.lastResponse) {
      emitLastResponse(entry, parsed.lastResponse)
    }
  } catch {}
}

function isThreadSettled(state: CodexWorkState): boolean {
  return state === 'idle'
}

async function syncThreadRead(entry: SessionEntry): Promise<void> {
  if (!entry.threadId) return

  try {
    const appServer = getCodexAppServer()
    const response = await appServer.request<CodexThreadReadResponse>('thread/read', {
      threadId: entry.threadId,
      includeTurns: true,
    })
    const thread = response.thread
    if (!thread) return

    const threadState = getCodexWorkStateFromThread(thread)
    emitWorkState(entry, threadState)

    const lastResponse = extractLastCodexResponse(thread)
    if (lastResponse && (!entry.lastResponse || isThreadSettled(threadState))) {
      emitLastResponse(entry, lastResponse)
    }
  } catch {}
}

async function tick(): Promise<void> {
  if (tickInFlight || sessions.size === 0) return
  tickInFlight = true

  try {
    for (const entry of sessions.values()) {
      // Once a live Codex PID is pinned to a rollout, keep that binding stable.
      // A second Codex session in the same cwd can create a newer rollout file.
      if (entry.codexPid && (!entry.threadId || entry.bindingSource !== 'pid')) {
        const directMatch = findCodexRolloutByDirectory(CODEX_SESSIONS_DIR, entry.cwd, entry.createdAt)
        debugWorkState('codex-dir-scan', {
          sessionId: entry.sessionId.slice(0, 8),
          codexPid: entry.codexPid,
          currentRollout: entry.rolloutPath?.split('/').pop() ?? null,
          scanResult: directMatch ? directMatch.path.split('/').pop() : null,
          scanThreadId: directMatch?.threadId?.slice(0, 12) ?? null,
          switched: directMatch ? directMatch.path !== entry.rolloutPath : false,
        })
        if (directMatch && (directMatch.path !== entry.rolloutPath || directMatch.threadId !== entry.threadId)) {
          // Don't steal a thread already owned by another session
          const existingOwner = threadOwners.get(directMatch.threadId)
          if (!existingOwner || existingOwner === entry.sessionId) {
            bindThread(entry, directMatch.threadId, directMatch.path, 'pid')
          }
        }
      }

      if (entry.rolloutPath) {
        readRolloutState(entry)
      }
    }

    const appServer = getCodexAppServer()
    debugWorkState('codex-tick-start', {
      sessionCount: sessions.size,
      entries: [...sessions.values()].map((e) => ({
        sid: e.sessionId.slice(0, 8),
        pid: e.codexPid ?? null,
        rollout: !!e.rolloutPath,
        threadId: e.threadId?.slice(0, 8) ?? null,
        state: e.lastWorkState,
      })),
    })
    const loadedResponse = await appServer.request<{ data?: string[] }>('thread/loaded/list', {})
    const loadedThreadIds = new Set(loadedResponse.data ?? [])

    const watchedCwds = [...new Set([...sessions.values()].map((entry) => entry.cwd))]
    const threadLists = await Promise.all(
      watchedCwds.map(async (cwd) => {
        const response = await appServer.request<{ data?: CodexThreadSummary[] }>('thread/list', {
          cwd,
          archived: false,
          limit: 50,
          sortKey: 'updated_at',
        })
        return [cwd, response.data ?? []] as const
      }),
    )

    const threadsByCwd = new Map<string, CodexThreadSummary[]>(threadLists)
    const threadReads = new Map<string, CodexThreadDetail | null>()

    const readThread = async (threadId: string): Promise<CodexThreadDetail | null> => {
      if (threadReads.has(threadId)) {
        return threadReads.get(threadId) ?? null
      }

      try {
        const response = await appServer.request<CodexThreadReadResponse>('thread/read', {
          threadId,
          includeTurns: true,
        })
        const thread = response.thread ?? null
        threadReads.set(threadId, thread)
        return thread
      } catch (err) {
        debugWorkState('codex-thread-read-error', { threadId: threadId.slice(0, 8), error: String(err) })
        threadReads.set(threadId, null)
        return null
      }
    }

    for (const entry of sessions.values()) {
      // Never bind a session to an arbitrary thread by cwd alone when we
      // don't have a live PID or rollout path for that exact terminal session.
      if (!entry.codexPid && !entry.rolloutPath && !entry.threadId) {
        emitWorkState(entry, 'idle')
        continue
      }

      if (entry.rolloutPath && entry.threadId) {
        // Keep the rollout file in sync for fast local updates, then let the
        // thread read refine work state and the final agent message.
        const threads = threadsByCwd.get(entry.cwd) ?? []
        const matched = threads.find((candidate) => candidate.id === entry.threadId)
        if (entry.bindingSource === 'heuristic' && matched && !wasCodexThreadUpdatedForProcess(matched, entry.createdAt)) {
          debugWorkState('codex-stale-thread-release', {
            sessionId: entry.sessionId.slice(0, 8),
            threadId: matched.id.slice(0, 8),
            updatedAt: matched.updatedAt,
            processStartedAtMs: entry.createdAt,
          })
          releaseThread(entry)
          clearLastResponse(entry)
          emitWorkState(entry, 'idle')
          continue
        }
        if (matched) {
          const updatedAtMs = matched.updatedAt * 1000
          if (entry.lastThreadUpdatedAt !== updatedAtMs || entry.rolloutPath !== (matched.path ?? null)) {
            entry.lastThreadUpdatedAt = updatedAtMs
            entry.rolloutPath = matched.path ?? null
            entry.rolloutSize = 0
            readRolloutState(entry)
          }
        }

        const thread = await readThread(entry.threadId)
        if (thread) {
          const latestTurn = thread.turns?.[thread.turns.length - 1]
          debugWorkState('codex-thread-detail', {
            sessionId: entry.sessionId.slice(0, 8),
            threadStatus: thread.status,
            turnCount: thread.turns?.length ?? 0,
            latestTurnStatus: latestTurn?.status ?? null,
            latestTurnItemCount: latestTurn?.items?.length ?? 0,
          })
          const threadState = getCodexWorkStateFromThread(thread)
          emitWorkState(entry, threadState)
          const lastResponse = extractLastCodexResponse(thread)
          if (lastResponse && (!entry.lastResponse || isThreadSettled(threadState))) {
            emitLastResponse(entry, lastResponse)
          }
        }
        continue
      }

      const threads = threadsByCwd.get(entry.cwd) ?? []
      let thread = entry.threadId ? threads.find((candidate) => candidate.id === entry.threadId) ?? null : null

      if (entry.bindingSource === 'heuristic' && thread && !wasCodexThreadUpdatedForProcess(thread, entry.createdAt)) {
        debugWorkState('codex-stale-thread-release', {
          sessionId: entry.sessionId.slice(0, 8),
          threadId: thread.id.slice(0, 8),
          updatedAt: thread.updatedAt,
          processStartedAtMs: entry.createdAt,
        })
        releaseThread(entry)
        clearLastResponse(entry)
        thread = null
      }

      if (!thread) {
        const heuristicThreads = getHeuristicAssignableThreads(entry, threads)
        const pickedThreadId = pickAssignableCodexThreadId(
          heuristicThreads,
          entry.createdAt,
          loadedThreadIds,
          threadOwners,
          entry.sessionId,
        )

        if (pickedThreadId) {
          thread = threads.find((candidate) => candidate.id === pickedThreadId) ?? null
          if (thread) {
            bindThread(entry, pickedThreadId, thread.path ?? null, 'heuristic')
          }
        } else {
          emitWorkState(entry, 'idle')
          continue
        }
      }

      if (!thread) continue

      const threadDetail = await readThread(thread.id)
      if (threadDetail) {
        emitWorkState(entry, getCodexWorkStateFromThread(threadDetail))
        const lastResponse = extractLastCodexResponse(threadDetail)
        if (lastResponse) {
          emitLastResponse(entry, lastResponse)
        }
      } else {
        // Fall back to the coarse thread-list status when the full read fails.
        emitWorkState(entry, getCodexWorkState(thread.status))
      }

      const updatedAtMs = thread.updatedAt * 1000
      if (entry.lastThreadUpdatedAt !== updatedAtMs || entry.rolloutPath !== (thread.path ?? null)) {
        entry.lastThreadUpdatedAt = updatedAtMs
        entry.rolloutPath = thread.path ?? null
        entry.rolloutSize = 0
      }

      readRolloutState(entry)
    }
  } catch (err) {
    debugWorkState('codex-tick-error', { error: String(err), stack: (err as Error)?.stack?.slice(0, 500) ?? '' })
    // Preserve the last known rollout/thread-derived state while app-server requests recover.
  } finally {
    tickInFlight = false
    if (tickQueued) {
      tickQueued = false
      scheduleTick()
    }
  }
}

export function initCodexWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function watchCodexSession(sessionId: string, cwd: string, codexPid?: number): void {
  const existing = sessions.get(sessionId)
  if (existing) {
    const decision = getCodexWatchRegistrationDecision(existing, { cwd, codexPid })
    existing.cwd = cwd
    if (decision.shouldResetBinding) {
      const pidChanged = codexPid != null && codexPid !== existing.codexPid
      if (codexPid != null) {
        existing.codexPid = codexPid
      }
      releaseThread(existing)
      clearLastResponse(existing)
      if (pidChanged) {
        void getProcessStartTimeMs(codexPid).then((startedAt) => {
          const current = sessions.get(sessionId)
          if (current && startedAt) {
            current.createdAt = startedAt
            releaseThread(current)
            clearLastResponse(current)
            scheduleTick()
          }
        })
      }
    } else if (codexPid) {
      existing.codexPid = codexPid
    }
    ensurePolling()
    scheduleTick()
    return
  }

  const entry: SessionEntry = {
    sessionId,
    cwd,
    createdAt: Date.now(),
    threadId: null,
    bindingSource: null,
    lastThreadUpdatedAt: null,
    rolloutPath: null,
    rolloutSize: 0,
    lastResponse: '',
    lastWorkState: 'idle',
    codexPid,
  }

  sessions.set(sessionId, entry)
  ensurePolling()
  scheduleTick()

  if (codexPid) {
    void getProcessStartTimeMs(codexPid).then((startedAt) => {
      const current = sessions.get(sessionId)
      if (current && startedAt) {
        current.createdAt = startedAt
        scheduleTick()
      }
    })
  }
}

export function unwatchCodexSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  releaseThread(entry)
  sessions.delete(sessionId)
  maybeStopPolling()
}

export function getCodexWatcherDebugState(): Record<string, unknown>[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    codexPid: entry.codexPid ?? null,
    threadId: entry.threadId,
    bindingSource: entry.bindingSource,
    rolloutPath: entry.rolloutPath,
    rolloutSize: entry.rolloutSize,
    lastWorkState: entry.lastWorkState,
    lastResponse: entry.lastResponse?.slice(0, 50) || '',
    createdAt: entry.createdAt,
    lastThreadUpdatedAt: entry.lastThreadUpdatedAt,
  }))
}

export function stopAllCodexWatchers(): void {
  sessions.clear()
  threadOwners.clear()
  removeNotificationListener?.()
  removeNotificationListener = null
  stopDirectoryWatch()
  if (interval) clearInterval(interval)
  interval = null
  tickInFlight = false
  tickQueued = false
  stopCodexAppServer()
}
