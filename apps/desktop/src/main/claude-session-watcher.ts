// src/main/claude-session-watcher.ts
// Watches Claude Code JSONL session files to capture the last assistant response
// and PTY title updates to determine whether Claude is currently working.
//
// Uses a per-directory coordinator to ensure that when a new JSONL file appears,
// it is assigned to the correct session (the one that most recently started Claude).
// This eliminates cross-session contamination that occurred when independent
// watchers raced to claim files.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import { parseJsonlLines, cleanForDisplay } from './claude-activity-parser'
import { pickBestJsonlPath, pickAssignableJsonlPath, type JsonlCandidate } from './claude-jsonl-matcher'
import { doesClaudeJsonlMatchPromptHints } from './claude-jsonl-prompts'
import { getClaudeWorkStateFromChunk } from './claude-work-indicator'
import type { ClaudeWorkState } from './claude-work-indicator'
import { PromptHistoryWriter, sanitizePromptText } from '../daemon/prompt-history-writer'
import type { AgentSessionRegistry } from './agent-session-authority'
import { mapClaudeHookToState } from './agent-session-authority'

let agentRegistry: AgentSessionRegistry | null = null

export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}
import type { ClaudeWatcherDebugState } from '../shared/types'
import { notifyIdleTransition } from './idle-notifier'
import { getLastMeaningfulText, getTerminalBufferText, hasRecentAgentBusyIndicator, hasRecentTerminalOutput } from './terminal-output-buffer'
import { debugWorkState } from './work-state-debug'
import type { ClaudeHookEventType } from './claude-hook-runtime'

export type { ClaudeWorkState }

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

// --- Per-session state ---

interface SessionEntry {
  sessionId: string
  cwd: string
  projectDir: string
  jsonlPath: string | null
  bindingSource: 'pid' | 'promptHints' | 'heuristic' | null
  lastResponse: string
  lastUserPrompt: string
  lastWorkState: ClaudeWorkState
  titleRemainder: string
  lastSize: number
  baselineSize: number
  /** Timestamp when watchSession was called — used to assign new files */
  createdAt: number
  /** Timestamp when the file last changed (for staleness detection) */
  lastFileChangeAt: number
  /** PID of the Claude process — used for lsof retries */
  claudePid: number | undefined
  /** How many lsof retries have been attempted */
  lsofRetries: number
  /** Timestamp when watchSession was called — used for startup grace period */
  watchStartedAt: number
  lastWorkStateSource: 'hook' | 'title' | 'jsonl' | 'terminal' | 'initial'
  lastWorkStateChangedAt: number
  lastHookEvent: ClaudeHookEventType | null
  lastHookEventAt: number | null
  lastTitleState: ClaudeWorkState | null
  lastTitleStateAt: number | null
  lastJsonlActivity: 'idle' | 'thinking' | 'tool_executing' | null
  lastJsonlActivityAt: number | null
  /** Timer that fires after STARTUP_GRACE_MS to apply a suppressed idle transition */
  startupIdleTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, SessionEntry>()

// --- Per-directory coordinator ---
// Ensures one fs.watch + interval per directory, and coordinates file assignment.

interface DirCoordinator {
  watcher: fs.FSWatcher | null
  interval: ReturnType<typeof setInterval>
  /** All JSONL files known at any point — maps path → assigned sessionId (or null) */
  knownFiles: Map<string, string | null>
  /** Session IDs watching this directory */
  sessionIds: Set<string>
}

const coordinators = new Map<string, DirCoordinator>()

/** JSONL files consumed by previous sessions — permanently ineligible for re-assignment.
 *  Survives coordinator destruction so files from killed sessions can never leak
 *  to new sessions, even when the coordinator is recreated from scratch. */
const consumedFiles = new Set<string>()
const pendingHookEvents = new Map<string, ClaudeHookEventType>()
const pendingLaunchStarts = new Set<string>()

let mainWindow: BrowserWindow | null = null

// --- Helpers ---

function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

function getJsonlFiles(projectDir: string): { path: string; mtime: number; size: number; birthtime: number }[] {
  try {
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = path.join(projectDir, f)
        try {
          const stat = fs.statSync(fullPath)
          return { path: fullPath, mtime: stat.mtimeMs, size: stat.size, birthtime: stat.birthtimeMs }
        } catch { return null }
      })
      .filter(Boolean) as { path: string; mtime: number; size: number; birthtime: number }[]
  } catch {
    return []
  }
}

function hasSiblingSessionInProjectDir(
  current: Pick<SessionEntry, 'sessionId' | 'projectDir'>
): boolean {
  for (const session of sessions.values()) {
    if (session.sessionId === current.sessionId) continue
    if (session.projectDir === current.projectDir) {
      return true
    }
  }

  return false
}

function getSessionPromptHints(sessionId: string): string[] {
  const history = PromptHistoryWriter.readHistory(sessionId)
  const promptHints: string[] = []
  const seen = new Set<string>()

  for (let index = history.length - 1; index >= 0 && promptHints.length < 5; index--) {
    const text = sanitizePromptText(history[index]?.text ?? '')
    if (!text || seen.has(text)) continue
    seen.add(text)
    promptHints.push(text)
  }

  return promptHints
}

function clearLastResponse(entry: SessionEntry): void {
  if (!entry.lastResponse) return
  entry.lastResponse = ''
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-last-response', entry.sessionId, '')
  }
}

// --- JSONL parsing ---

function parseJsonlTail(filePath: string, afterOffset: number): { lastResponse: string; lastUserPrompt: string; activity: 'idle' | 'thinking' | 'tool_executing' } {
  try {
    const stat = fs.statSync(filePath)
    const readFrom = Math.max(afterOffset, stat.size - 64 * 1024)
    const readSize = stat.size - readFrom
    if (readSize <= 0) return { lastResponse: '', lastUserPrompt: '', activity: 'idle' }

    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, readFrom)
    fs.closeSync(fd)

    const text = buffer.toString('utf-8')
    const lines = text.split('\n').filter((l) => l.trim())

    return parseJsonlLines(lines)
  } catch {
    return { lastResponse: '', lastUserPrompt: '', activity: 'idle' }
  }
}

function emitUpdates(entry: SessionEntry): void {
  if (!entry.jsonlPath) return

  try {
    const stat = fs.statSync(entry.jsonlPath)
    if (stat.size === entry.lastSize) return
    entry.lastSize = stat.size
    entry.lastFileChangeAt = Date.now()
  } catch { return }

  const { lastResponse, lastUserPrompt, activity } = parseJsonlTail(entry.jsonlPath, entry.baselineSize)
  entry.lastJsonlActivity = activity
  entry.lastJsonlActivityAt = Date.now()

  if (lastUserPrompt && lastUserPrompt !== entry.lastUserPrompt) {
    entry.lastUserPrompt = lastUserPrompt
  }

  if (lastResponse && lastResponse !== entry.lastResponse) {
    entry.lastResponse = lastResponse
    const clean = cleanForDisplay(lastResponse)
    if (clean && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-last-response', entry.sessionId, clean)
    }
  }

  // Use JSONL activity as a fallback work state source.
  // Title-based detection (observeTerminalData) is more real-time but can miss
  // the initial idle transition if the title was set before the watcher started.
  // In shared project directories, the terminal title is the only signal that
  // is definitively tied to a specific terminal session. Avoid JSONL-driven
  // work-state guesses there unless the binding came directly from the PID.
  if (hasSiblingSessionInProjectDir(entry) && entry.bindingSource !== 'pid') {
    return
  }

  const jsonlWorkState: ClaudeWorkState = activity === 'idle' ? 'idle' : 'working'
  emitWorkState(entry, jsonlWorkState, { source: 'jsonl' })
}

// --- Coordinator: assigns new files and drives updates ---

function getOrCreateCoordinator(projectDir: string): DirCoordinator {
  let coord = coordinators.get(projectDir)
  if (coord) return coord

  // Snapshot existing files. Files older than 10s are permanently consumed —
  // they belong to previous sessions and must never be reassigned.
  const knownFiles = new Map<string, string | null>()
  const now = Date.now()
  for (const f of getJsonlFiles(projectDir)) {
    knownFiles.set(f.path, null)
    if (f.birthtime < now - 10_000) {
      consumedFiles.add(f.path)
    }
  }

  const tick = () => {
    const c = coordinators.get(projectDir)
    if (!c) return

    // 1. Scan for new files.
    // Do not auto-assign them based on timing alone. With multiple Claude
    // sessions in the same project, time-based guesses are what caused one
    // session to steal another session's preview. PID-backed lsof matching
    // below is the authoritative binding path.
    const currentFiles = getJsonlFiles(projectDir)
    for (const f of currentFiles) {
      if (!c.knownFiles.has(f.path)) {
        c.knownFiles.set(f.path, null)
      }
    }

    const promptHintsBySession = new Map<string, string[]>()
    const getPromptHints = (sessionId: string): string[] => {
      if (promptHintsBySession.has(sessionId)) {
        return promptHintsBySession.get(sessionId) ?? []
      }

      const promptHints = getSessionPromptHints(sessionId)
      promptHintsBySession.set(sessionId, promptHints)
      return promptHints
    }

    for (const sid of c.sessionIds) {
      const entry = sessions.get(sid)
      if (!entry?.jsonlPath) continue

      // Cross-instance validation only matters when multiple sessions share
      // the same project directory. When there are no siblings, the heuristic
      // binding is definitively correct — skip the prompt-hint check to avoid
      // false-positive releases that cause rapid working→idle oscillation.
      if (!hasSiblingSessionInProjectDir(entry)) continue

      const promptHints = getPromptHints(entry.sessionId)
      if (promptHints.length === 0) continue
      if (doesClaudeJsonlMatchPromptHints(entry.jsonlPath, promptHints)) continue

      debugWorkState('claude-cross-instance-jsonl-release', {
        sessionId: entry.sessionId.slice(0, 8),
        cwd: entry.cwd,
        jsonlPath: entry.jsonlPath?.split('/').pop() ?? null,
        bindingSource: entry.bindingSource,
        promptHintCount: promptHints.length,
      })
      releaseFile(entry, c)
      clearLastResponse(entry)
      emitWorkState(entry, 'idle')
    }

    // 2. Retry lsof for sessions while Claude is still settling.
    // This lets PID-based matching correct an early wrong guess after the
    // actual Claude process and JSONL file become visible.
    const MAX_LSOF_RETRIES = 15 // ~30 seconds at 2s tick interval
    for (const sid of c.sessionIds) {
      const entry = sessions.get(sid)
      if (entry && entry.claudePid && entry.lsofRetries < MAX_LSOF_RETRIES) {
        entry.lsofRetries++
        tryAssignJsonlViaPid(entry, c).then((assigned) => {
          if (assigned) {
            emitUpdates(entry)
          }
        }).catch(() => {})
      }
    }

    // 2b. Prompt-guided JSONL assignment, then a heuristic fallback only when
    // this project directory has a single active Claude session.
    for (const sid of c.sessionIds) {
      const entry = sessions.get(sid)
      if (!entry || entry.jsonlPath) continue

      const promptHints = getPromptHints(entry.sessionId)
      const promptMatchedPath = findPromptMatchedJsonlPath(entry, c, currentFiles, promptHints)
      if (promptMatchedPath && assignFile(entry, c, promptMatchedPath, 'promptHints')) {
        emitUpdates(entry)
        continue
      }

      if (hasSiblingSessionInProjectDir(entry)) continue

      const candidates: JsonlCandidate[] = currentFiles
        .filter((f) => f.birthtime >= entry.createdAt - 10_000)
        .map((f) => ({ path: f.path, birthtime: f.birthtime, mtime: f.mtime }))

      const bestPath = pickAssignableJsonlPath(
        candidates,
        entry.createdAt,
        c.knownFiles,
        entry.sessionId
      )
      if (bestPath) {
        assignFile(entry, c, bestPath, 'heuristic')
      }
    }

    // 3. Emit updates for all sessions in this directory
    for (const sid of c.sessionIds) {
      const entry = sessions.get(sid)
      if (!entry) continue
      emitUpdates(entry)
      applyTerminalIdleFallback(entry)
    }
  }

  let fsWatcher: fs.FSWatcher | null = null
  try {
    if (fs.existsSync(projectDir)) {
      fsWatcher = fs.watch(projectDir, { persistent: false }, () => tick())
      fsWatcher.on('error', () => {})
    }
  } catch {}

  const interval = setInterval(tick, 2000)

  coord = { watcher: fsWatcher, interval, knownFiles, sessionIds: new Set() }
  coordinators.set(projectDir, coord)

  return coord
}

function removeFromCoordinator(projectDir: string, sessionId: string): void {
  const coord = coordinators.get(projectDir)
  if (!coord) return

  coord.sessionIds.delete(sessionId)

  // Mark the file as permanently consumed so no future session can claim it
  const entry = sessions.get(sessionId)
  if (entry?.jsonlPath) {
    consumedFiles.add(entry.jsonlPath)
    coord.knownFiles.set(entry.jsonlPath, null)
  }

  // Clean up coordinator if no more sessions
  if (coord.sessionIds.size === 0) {
    clearInterval(coord.interval)
    coord.watcher?.close()
    coordinators.delete(projectDir)
  }
}

function releaseFile(entry: SessionEntry, coord: DirCoordinator): void {
  if (entry.jsonlPath && coord.knownFiles.get(entry.jsonlPath) === entry.sessionId) {
    coord.knownFiles.set(entry.jsonlPath, null)
  }

  entry.jsonlPath = null
  entry.bindingSource = null
  entry.baselineSize = 0
  entry.lastSize = 0
}

function findPromptMatchedJsonlPath(
  entry: SessionEntry,
  coord: DirCoordinator,
  currentFiles: Array<{ path: string; mtime: number; size: number; birthtime: number }>,
  promptHints: string[]
): string | null {
  if (promptHints.length === 0) return null

  const matchedCandidates: JsonlCandidate[] = currentFiles
    .filter((file) => file.birthtime >= entry.createdAt - 10_000)
    .filter((file) => doesClaudeJsonlMatchPromptHints(file.path, promptHints))
    .map((file) => ({ path: file.path, birthtime: file.birthtime, mtime: file.mtime }))

  if (matchedCandidates.length === 0) return null

  if (
    entry.jsonlPath
    && matchedCandidates.some((candidate) => candidate.path === entry.jsonlPath)
    && coord.knownFiles.get(entry.jsonlPath) === entry.sessionId
  ) {
    return entry.jsonlPath
  }

  const assignableMatches = matchedCandidates.filter((candidate) => {
    const owner = coord.knownFiles.get(candidate.path)
    return !owner || owner === entry.sessionId
  })
  if (assignableMatches.length !== 1) return null

  return pickBestJsonlPath(assignableMatches, entry.createdAt)
}

// --- lsof-based file discovery ---

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

/**
 * Use lsof to find all JSONL files a Claude process currently has open.
 */
function findJsonlViaPid(claudePid: number, projectDir: string): Promise<JsonlCandidate[]> {
  return new Promise((resolve) => {
    execFile('lsof', ['-p', String(claudePid), '-Fn'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return }
      const matches = new Set<string>()
      // lsof -Fn outputs lines like "n/path/to/file"
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n') && line.endsWith('.jsonl') && line.includes(projectDir)) {
          matches.add(line.slice(1)) // strip the 'n' prefix
        }
      }

      const candidates = [...matches].map((filePath) => {
        try {
          const stat = fs.statSync(filePath)
          return {
            path: filePath,
            birthtime: stat.birthtimeMs,
            mtime: stat.mtimeMs,
          }
        } catch {
          return null
        }
      }).filter(Boolean) as JsonlCandidate[]

      resolve(candidates)
    })
  })
}

/**
 * Assign a JSONL file to a session entry and register it with the coordinator.
 */
function assignFile(
  entry: SessionEntry,
  coord: DirCoordinator,
  filePath: string,
  source: SessionEntry['bindingSource'],
  options: { forceTakeover?: boolean } = {}
): boolean {
  // Never assign a file consumed by a previous session
  if (consumedFiles.has(filePath)) return false

  if (entry.jsonlPath === filePath) {
    coord.knownFiles.set(filePath, entry.sessionId)
    entry.bindingSource = source
    return false
  }

  const currentOwner = coord.knownFiles.get(filePath)
  if (currentOwner && currentOwner !== entry.sessionId) {
    // Never steal a file that another active session still claims.
    // lsof can produce false positives when Claude CLI briefly reads
    // existing JSONL files during startup — this prevents Session B
    // from hijacking Session A's file.
    const previousOwner = sessions.get(currentOwner)
    if (previousOwner?.jsonlPath === filePath) {
      return false
    }
    if (!options.forceTakeover) {
      return false
    }
  }

  if (entry.jsonlPath && entry.jsonlPath !== filePath) {
    coord.knownFiles.set(entry.jsonlPath, null)
  }

  coord.knownFiles.set(filePath, entry.sessionId)
  entry.jsonlPath = filePath
  entry.bindingSource = source
  // Read from beginning to get full context
  entry.baselineSize = 0
  entry.lastSize = 0
  entry.lastFileChangeAt = Date.now()
  return true
}

async function tryAssignJsonlViaPid(entry: SessionEntry, coord: DirCoordinator): Promise<boolean> {
  if (!entry.claudePid) return false

  const candidates = await findJsonlViaPid(entry.claudePid, entry.projectDir)
  const filePath = pickBestJsonlPath(candidates, entry.createdAt)
  if (!filePath || !sessions.has(entry.sessionId)) return false
  if (entry.jsonlPath === filePath) {
    entry.bindingSource = 'pid'
    return false
  }

  return assignFile(entry, coord, filePath, 'pid', { forceTakeover: true })
}

function refreshAssignmentFromPid(entry: SessionEntry): void {
  const coord = coordinators.get(entry.projectDir)
  if (!coord || !entry.claudePid) return

  tryAssignJsonlViaPid(entry, coord).then((assigned) => {
    if (assigned) {
      emitUpdates(entry)
    }
  }).catch(() => {})

  const pid = entry.claudePid
  getProcessStartTimeMs(pid).then((startedAt) => {
    const current = sessions.get(entry.sessionId)
    if (!current || current.claudePid !== pid) return
    if (startedAt) {
      current.createdAt = startedAt
    }
    current.lsofRetries = 0
    const currentCoord = coordinators.get(current.projectDir)
    if (!currentCoord) return
    return tryAssignJsonlViaPid(current, currentCoord).then((assigned) => {
      if (assigned) {
        emitUpdates(current)
      }
    })
  }).catch(() => {})
}

/** Pending idle notification timeouts — keyed by session ID for cancellation. */
const pendingIdleNotify = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule an idle notification with a brief delay so the JSONL file has time
 * to be fully written.  This prevents sending stale `lastResponse` values when
 * the terminal title transitions to idle before the JSONL is flushed.
 */
function scheduleIdleNotification(sessionId: string): void {
  // Cancel any previously scheduled notification for this session
  const prev = pendingIdleNotify.get(sessionId)
  if (prev) clearTimeout(prev)

  const timer = setTimeout(() => {
    pendingIdleNotify.delete(sessionId)
    const entry = sessions.get(sessionId)
    if (!entry || entry.lastWorkState !== 'idle') return

    // Force a fresh JSONL read to get the most recent response
    if (entry.jsonlPath) {
      try {
        const stat = fs.statSync(entry.jsonlPath)
        // Always re-read — the file may have been updated since the last tick
        entry.lastSize = stat.size
        entry.lastFileChangeAt = Date.now()
        const { lastResponse, lastUserPrompt } = parseJsonlTail(entry.jsonlPath, entry.baselineSize)
        if (lastResponse) {
          entry.lastResponse = lastResponse
          const clean = cleanForDisplay(lastResponse)
          if (clean && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claude-last-response', entry.sessionId, clean)
          }
        }
        if (lastUserPrompt) {
          entry.lastUserPrompt = lastUserPrompt
        }
      } catch {}
    }

    // If JSONL-based response extraction failed (no binding, stale file, etc.),
    // fall back to the terminal output buffer which always has the rendered text.
    const responseForNotification = entry.lastResponse || getLastMeaningfulText(entry.sessionId)

    void notifyIdleTransition(entry.sessionId, 'claude', responseForNotification || undefined, entry.lastUserPrompt || undefined)
  }, 800)

  pendingIdleNotify.set(sessionId, timer)
}

/** During the first seconds after watchSession, suppress idle transitions.
 *  Claude Code sets its terminal title to the idle marker during startup
 *  before it begins processing, which causes a false idle→notification flicker. */
const STARTUP_GRACE_MS = 5_000
const TERMINAL_IDLE_FALLBACK_DELAY_MS = 4_000
const RECENT_JSONL_ACTIVITY_GRACE_MS = 12_000
const RECENT_TERMINAL_BUSY_GRACE_MS = 12_000

function isClaudeIdlePromptVisible(sessionId: string): boolean {
  const tail = getTerminalBufferText(sessionId).slice(-1600).toLowerCase()
  if (!tail) return false

  const hasPrompt = tail.includes('❯') || tail.includes('\n>')
  const hasClaudeIdleUi =
    tail.includes('shift+tab to cycle')
    || tail.includes('bypass permissions on')
    || tail.includes('run /init')
    || tail.includes('no recent activity')

  if (!hasPrompt || !hasClaudeIdleUi) return false

  // Claude Code's newer UI always shows the prompt area even while working.
  // Check for active work indicators that prove the agent is NOT idle despite
  // the prompt being visible.
  const hasWorkingIndicators =
    // Status line spinners and activity text (e.g. "Flambéing…", "Running…")
    /flambé|simmering|running\.\.\.|thinking\.\.\.|compiling|searching/i.test(tail)
    // Tool use output markers
    || tail.includes('bash(') || tail.includes('read(') || tail.includes('write(')
    || tail.includes('edit(') || tail.includes('grep(') || tail.includes('glob(')
    || tail.includes('agent(') || tail.includes('explore(')
    // Subagent activity
    || tail.includes('more tool uses')
    // Claude status spinner characters near the end of the buffer
    || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●⏵]\s/.test(tail.slice(-400))

  return !hasWorkingIndicators
}

function hasFreshWorkingTitle(entry: Pick<SessionEntry, 'lastTitleState' | 'lastTitleStateAt'>): boolean {
  if (entry.lastTitleState !== 'working') return false
  if (entry.lastTitleStateAt == null) return true
  return (Date.now() - entry.lastTitleStateAt) < TERMINAL_IDLE_FALLBACK_DELAY_MS
}

function applyTerminalIdleFallback(entry: SessionEntry): void {
  if (entry.lastWorkState !== 'working') return
  if (Date.now() - entry.watchStartedAt < TERMINAL_IDLE_FALLBACK_DELAY_MS) return
  if (
    entry.lastHookEvent === 'Start'
    && entry.lastHookEventAt != null
    && Date.now() - entry.lastHookEventAt < TERMINAL_IDLE_FALLBACK_DELAY_MS
  ) {
    return
  }
  if (hasFreshWorkingTitle(entry)) return
  const hasFreshJsonlWork =
    entry.lastJsonlActivity != null
    && entry.lastJsonlActivity !== 'idle'
    && entry.lastJsonlActivityAt != null
    && (Date.now() - entry.lastJsonlActivityAt) < RECENT_JSONL_ACTIVITY_GRACE_MS
  if (hasFreshJsonlWork) return
  if (hasRecentTerminalOutput(entry.sessionId, TERMINAL_IDLE_FALLBACK_DELAY_MS)) return
  if (hasRecentAgentBusyIndicator(entry.sessionId, RECENT_TERMINAL_BUSY_GRACE_MS)) return
  if (!isClaudeIdlePromptVisible(entry.sessionId)) return

  debugWorkState('claude-terminal-idle-fallback', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    claudePid: entry.claudePid ?? null,
    jsonlPath: entry.jsonlPath,
    lastTitleState: entry.lastTitleState,
    lastJsonlActivity: entry.lastJsonlActivity,
  })
  emitWorkState(entry, 'idle', { allowDuringStartup: true, source: 'terminal' })
}

function emitWorkState(
  entry: SessionEntry,
  nextState: ClaudeWorkState,
  options: { allowDuringStartup?: boolean; source?: 'hook' | 'title' | 'jsonl' | 'terminal' | 'initial' } = {}
): void {
  if (nextState === entry.lastWorkState) return
  const inStartup = (Date.now() - entry.watchStartedAt) < STARTUP_GRACE_MS
  if (!options.allowDuringStartup && nextState === 'idle' && inStartup) {
    debugWorkState('claude-work-state-suppressed', {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      claudePid: entry.claudePid ?? null,
      jsonlPath: entry.jsonlPath,
      nextState,
      source: options.source ?? 'initial',
      reason: 'startup-grace',
    })
    // Schedule a deferred re-evaluation after the grace period expires.
    // Claude only sends the idle title once — if we suppress it here and
    // Claude stays idle, there will be no second title update to correct it.
    if (!entry.startupIdleTimer) {
      const remaining = STARTUP_GRACE_MS - (Date.now() - entry.watchStartedAt) + 100
      entry.startupIdleTimer = setTimeout(() => {
        entry.startupIdleTimer = null
        if (entry.lastTitleState === 'idle' || entry.lastHookEvent === 'Stop') {
          emitWorkState(entry, 'idle', { allowDuringStartup: true, source: options.source })
        }
      }, remaining)
    }
    return
  }

  // Hook authority: only block non-hook idle transitions when the last hook
  // said Start (working) and it's still fresh.  If the last hook was Stop or
  // PermissionRequest, there's nothing to protect — let fallback sources through.
  const hookFreshnessMs = 15_000
  const lastHookIsStart = entry.lastHookEvent === 'Start'
  const hookIsFresh =
    lastHookIsStart &&
    entry.lastHookEventAt != null &&
    (Date.now() - entry.lastHookEventAt) < hookFreshnessMs
  const isNonHookSource = options.source !== 'hook' && options.source !== 'initial'

  if (hookIsFresh && isNonHookSource && nextState === 'idle') {
    return
  }

  // A real transition is happening — cancel any pending startup idle timer
  if (entry.startupIdleTimer) {
    clearTimeout(entry.startupIdleTimer)
    entry.startupIdleTimer = null
  }
  entry.lastWorkState = nextState
  entry.lastWorkStateSource = options.source ?? 'initial'
  entry.lastWorkStateChangedAt = Date.now()
  debugWorkState('claude-work-state', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    claudePid: entry.claudePid ?? null,
    jsonlPath: entry.jsonlPath,
    state: nextState,
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-work-state', entry.sessionId, nextState)
  }
  // Feed normalized registry
  if (agentRegistry) {
    if (options.source === 'hook') {
      agentRegistry.transition(entry.sessionId, nextState === 'idle' ? 'idle' : 'working', 'claude-hooks')
    } else {
      agentRegistry.transitionFallback(entry.sessionId, nextState === 'idle' ? 'idle' : 'working', 'claude-watcher-fallback')
    }
  }
  if (nextState === 'idle') {
    scheduleIdleNotification(entry.sessionId)
  } else {
    // If state changed away from idle, cancel any pending notification
    const pending = pendingIdleNotify.get(entry.sessionId)
    if (pending) {
      clearTimeout(pending)
      pendingIdleNotify.delete(entry.sessionId)
    }
  }
}

function applyPendingHookEvent(entry: SessionEntry): void {
  const eventType = pendingHookEvents.get(entry.sessionId)
  if (!eventType) return
  pendingHookEvents.delete(entry.sessionId)

  if (eventType === 'Start') {
    emitWorkState(entry, 'working', { source: 'hook' })
    return
  }

  if (eventType === 'PermissionRequest') {
    // DUAL BEHAVIOR during migration:
    //
    // Normalized path: PermissionRequest is first-class → waitingApproval.
    // The normalized registry gets the precise state. Renderer components
    // reading normalizedAgentState will see waitingApproval.
    //
    // Legacy path: ClaudeWorkState is 'idle' | 'working' — no waitingApproval
    // variant exists. The legacy IPC channel still sees 'idle' so that existing
    // code (sessionNeedsUserInput, agentLaunch clearing) keeps working.
    // This legacy path will be removed once all renderer code reads normalized state.
    if (agentRegistry) {
      agentRegistry.transition(entry.sessionId, 'waitingApproval', 'claude-hooks')
    }
    emitUpdates(entry)
    emitWorkState(entry, 'idle', { allowDuringStartup: true, source: 'hook' })
    return
  }

  // Stop
  emitUpdates(entry)
  emitWorkState(entry, 'idle', { allowDuringStartup: true, source: 'hook' })
}

function applyPendingLaunchStart(entry: SessionEntry): void {
  if (!pendingLaunchStarts.has(entry.sessionId)) return
  pendingLaunchStarts.delete(entry.sessionId)
  emitWorkState(entry, 'working', { source: 'initial' })
}

export function applyClaudeHookEvent(sessionId: string, eventType: ClaudeHookEventType): void {
  pendingHookEvents.set(sessionId, eventType)

  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.lastHookEvent = eventType
  entry.lastHookEventAt = Date.now()

  // Feed normalized registry with precise state
  if (agentRegistry) {
    agentRegistry.transition(sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
  }

  debugWorkState('claude-hook-event', {
    sessionId,
    cwd: entry.cwd,
    eventType,
    jsonlPath: entry.jsonlPath,
    claudePid: entry.claudePid ?? null,
  })

  applyPendingHookEvent(entry)
}

export function markClaudeSessionStarted(sessionId: string): void {
  pendingLaunchStarts.add(sessionId)
  pendingHookEvents.delete(sessionId)

  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('claude-session-started', {
    sessionId,
    cwd: entry.cwd,
    claudePid: entry.claudePid ?? null,
    jsonlPath: entry.jsonlPath,
  })

  const coord = coordinators.get(entry.projectDir)
  if (coord) {
    releaseFile(entry, coord)
  } else {
    entry.jsonlPath = null
    entry.bindingSource = null
    entry.baselineSize = 0
    entry.lastSize = 0
  }
  const pendingIdle = pendingIdleNotify.get(sessionId)
  if (pendingIdle) {
    clearTimeout(pendingIdle)
    pendingIdleNotify.delete(sessionId)
  }
  if (entry.startupIdleTimer) {
    clearTimeout(entry.startupIdleTimer)
    entry.startupIdleTimer = null
  }

  entry.createdAt = Date.now()
  entry.watchStartedAt = entry.createdAt
  entry.lastFileChangeAt = entry.createdAt
  entry.titleRemainder = ''
  entry.lastHookEvent = null
  entry.lastHookEventAt = null
  entry.lastTitleState = null
  entry.lastTitleStateAt = null
  entry.lastJsonlActivity = null
  entry.lastJsonlActivityAt = null
  entry.lsofRetries = 0
  clearLastResponse(entry)
  entry.lastUserPrompt = ''
  if (agentRegistry) {
    agentRegistry.reset(sessionId)
    // Use fallback authority — this is an optimistic "working" from the launch,
    // not an actual hook event. Using 'claude-hooks' would block all fallback
    // idle transitions for 60s even when hooks never fire.
    agentRegistry.transitionFallback(sessionId, 'working', 'claude-watcher-fallback')
  }
  applyPendingLaunchStart(entry)
}

export function observeTerminalData(sessionId: string, data: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  const parsed = getClaudeWorkStateFromChunk(data, entry.titleRemainder)
  entry.titleRemainder = parsed.remainder

  if (parsed.state) {
    if (entry.lastTitleState !== parsed.state) {
      debugWorkState('claude-title-state', {
        sessionId,
        cwd: entry.cwd,
        claudePid: entry.claudePid ?? null,
        jsonlPath: entry.jsonlPath,
        state: parsed.state,
      })
    }
    entry.lastTitleState = parsed.state
    entry.lastTitleStateAt = Date.now()
    emitWorkState(entry, parsed.state, { source: 'title' })
  }
}

// --- Public API ---

export function watchSession(sessionId: string, cwd: string, claudePid?: number): void {
  // If already watching, update the PID for lsof retries and reset retry counter
  const existing = sessions.get(sessionId)
  if (existing) {
    debugWorkState('claude-watch-session', {
      sessionId,
      cwd,
      claudePid: claudePid ?? existing.claudePid ?? null,
      existing: true,
      jsonlPath: existing.jsonlPath,
      bindingSource: existing.bindingSource,
    })
    existing.cwd = cwd
    if (claudePid && claudePid !== existing.claudePid) {
      existing.claudePid = claudePid
      existing.lsofRetries = 0 // reset retries for new PID
      refreshAssignmentFromPid(existing)
    } else if (claudePid && !existing.jsonlPath) {
      existing.claudePid = claudePid
      existing.lsofRetries = 0
      refreshAssignmentFromPid(existing)
    }
    return
  }

  const projectKey = cwdToProjectDir(cwd)
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey)

  const entry: SessionEntry = {
    sessionId,
    cwd,
    projectDir,
    jsonlPath: null,
    bindingSource: null,
    lastResponse: '',
    lastUserPrompt: '',
    lastWorkState: 'idle',
    titleRemainder: '',
    lastSize: 0,
    baselineSize: 0,
    createdAt: Date.now(),
    lastFileChangeAt: Date.now(),
    claudePid,
    lsofRetries: 0,
    watchStartedAt: Date.now(),
    lastWorkStateSource: 'initial',
    lastWorkStateChangedAt: Date.now(),
    lastHookEvent: null,
    lastHookEventAt: null,
    lastTitleState: null,
    lastTitleStateAt: null,
    lastJsonlActivity: null,
    lastJsonlActivityAt: null,
    startupIdleTimer: null,
  }
  sessions.set(sessionId, entry)
  if (agentRegistry) {
    agentRegistry.register(sessionId, 'claude')
  }
  debugWorkState('claude-watch-session', {
    sessionId,
    cwd,
    claudePid: claudePid ?? null,
    existing: false,
    jsonlPath: null,
    bindingSource: null,
  })
  applyPendingLaunchStart(entry)
  applyPendingHookEvent(entry)

  const coord = getOrCreateCoordinator(projectDir)
  coord.sessionIds.add(sessionId)

  // Try to find the JSONL file via lsof first
  if (claudePid) {
    refreshAssignmentFromPid(entry)
  }

  // Timing-based fallback: Claude CLI doesn't keep JSONL files open,
  // so lsof often fails. Try prompt-guided matching first, then only fall back
  // to birthtime when this project directory has a single active Claude session.
  if (!entry.jsonlPath) {
    const currentFiles = getJsonlFiles(projectDir)
    const promptHints = getSessionPromptHints(entry.sessionId)
    const promptMatchedPath = findPromptMatchedJsonlPath(entry, coord, currentFiles, promptHints)
    if (promptMatchedPath && assignFile(entry, coord, promptMatchedPath, 'promptHints')) {
      emitUpdates(entry)
      return
    }

    if (hasSiblingSessionInProjectDir(entry)) {
      return
    }

    const candidates: JsonlCandidate[] = currentFiles
      .filter((f) => f.birthtime >= entry.createdAt - 10_000)
      .map((f) => ({ path: f.path, birthtime: f.birthtime, mtime: f.mtime }))

    const bestPath = pickAssignableJsonlPath(
      candidates,
      entry.createdAt,
      coord.knownFiles,
      entry.sessionId
    )
    if (bestPath) {
      assignFile(entry, coord, bestPath, 'heuristic')
      emitUpdates(entry)
    }
  }
}

export function unwatchSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  debugWorkState('claude-unwatch-session', {
    sessionId,
    cwd: entry.cwd,
    claudePid: entry.claudePid ?? null,
    jsonlPath: entry.jsonlPath,
    bindingSource: entry.bindingSource,
    lastWorkState: entry.lastWorkState,
  })

  // Cancel any pending idle notification
  const pending = pendingIdleNotify.get(sessionId)
  if (pending) {
    clearTimeout(pending)
    pendingIdleNotify.delete(sessionId)
  }

  // Cancel any pending startup idle timer
  if (entry.startupIdleTimer) {
    clearTimeout(entry.startupIdleTimer)
    entry.startupIdleTimer = null
  }

  removeFromCoordinator(entry.projectDir, sessionId)
  if (agentRegistry) {
    agentRegistry.unregister(sessionId)
  }
  sessions.delete(sessionId)
  pendingHookEvents.delete(sessionId)
  pendingLaunchStarts.delete(sessionId)
}

export function getClaudeWatcherDebugState(): ClaudeWatcherDebugState[] {
  return [...sessions.values()].map((entry) => ({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    projectDir: entry.projectDir,
    claudePid: entry.claudePid ?? null,
    jsonlPath: entry.jsonlPath,
    bindingSource: entry.bindingSource,
    lastWorkState: entry.lastWorkState,
    lastWorkStateSource: entry.lastWorkStateSource,
    lastWorkStateChangedAt: entry.lastWorkStateChangedAt,
    lastHookEvent: entry.lastHookEvent,
    lastHookEventAt: entry.lastHookEventAt,
    pendingHookEvent: pendingHookEvents.get(entry.sessionId) ?? null,
    lastTitleState: entry.lastTitleState,
    lastTitleStateAt: entry.lastTitleStateAt,
    lastJsonlActivity: entry.lastJsonlActivity,
    lastJsonlActivityAt: entry.lastJsonlActivityAt,
    lastResponsePreview: cleanForDisplay(entry.lastResponse).slice(0, 120),
    createdAt: entry.createdAt,
    watchStartedAt: entry.watchStartedAt,
    lastFileChangeAt: entry.lastFileChangeAt,
    lastSize: entry.lastSize,
    baselineSize: entry.baselineSize,
    lsofRetries: entry.lsofRetries,
    hasSiblingSessionInProjectDir: hasSiblingSessionInProjectDir(entry),
  }))
}

export function initClaudeWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function stopAllWatchers(): void {
  for (const [, coord] of coordinators) {
    clearInterval(coord.interval)
    coord.watcher?.close()
  }
  for (const timer of pendingIdleNotify.values()) {
    clearTimeout(timer)
  }
  for (const entry of sessions.values()) {
    if (entry.startupIdleTimer) clearTimeout(entry.startupIdleTimer)
  }
  pendingIdleNotify.clear()
  coordinators.clear()
  sessions.clear()
  consumedFiles.clear()
  pendingHookEvents.clear()
  pendingLaunchStarts.clear()
  mainWindow = null
}
