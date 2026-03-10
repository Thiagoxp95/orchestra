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
import { pickBestJsonlPath, type JsonlCandidate } from './claude-jsonl-matcher'
import { getClaudeWorkStateFromChunk } from './claude-work-indicator'
import type { ClaudeWorkState } from './claude-work-indicator'
import { notifyIdleTransition } from './idle-notifier'
import { debugWorkState } from './work-state-debug'

export type { ClaudeWorkState }

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

// --- Per-session state ---

interface SessionEntry {
  sessionId: string
  cwd: string
  projectDir: string
  jsonlPath: string | null
  lastResponse: string
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

// --- JSONL parsing ---

function parseJsonlTail(filePath: string, afterOffset: number): { lastResponse: string; activity: 'idle' | 'thinking' | 'tool_executing' } {
  try {
    const stat = fs.statSync(filePath)
    const readFrom = Math.max(afterOffset, stat.size - 64 * 1024)
    const readSize = stat.size - readFrom
    if (readSize <= 0) return { lastResponse: '', activity: 'idle' }

    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, readFrom)
    fs.closeSync(fd)

    const text = buffer.toString('utf-8')
    const lines = text.split('\n').filter((l) => l.trim())

    return parseJsonlLines(lines)
  } catch {
    return { lastResponse: '', activity: 'idle' }
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

  const { lastResponse } = parseJsonlTail(entry.jsonlPath, entry.baselineSize)

  if (lastResponse && lastResponse !== entry.lastResponse) {
    entry.lastResponse = lastResponse
    const clean = cleanForDisplay(lastResponse)
    if (clean && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-last-response', entry.sessionId, clean)
    }
  }
}

// --- Coordinator: assigns new files and drives updates ---

function getOrCreateCoordinator(projectDir: string): DirCoordinator {
  let coord = coordinators.get(projectDir)
  if (coord) return coord

  // Snapshot all existing files as unassigned
  const knownFiles = new Map<string, string | null>()
  for (const f of getJsonlFiles(projectDir)) {
    knownFiles.set(f.path, null)
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

    // 3. Emit updates for all sessions in this directory
    for (const sid of c.sessionIds) {
      const entry = sessions.get(sid)
      if (entry) emitUpdates(entry)
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

  // Unassign the file
  const entry = sessions.get(sessionId)
  if (entry?.jsonlPath) {
    coord.knownFiles.set(entry.jsonlPath, null)
  }

  // Clean up coordinator if no more sessions
  if (coord.sessionIds.size === 0) {
    clearInterval(coord.interval)
    coord.watcher?.close()
    coordinators.delete(projectDir)
  }
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
  options: { forceTakeover?: boolean } = {}
): boolean {
  const currentOwner = coord.knownFiles.get(filePath)
  if (currentOwner && currentOwner !== entry.sessionId) {
    if (!options.forceTakeover) {
      return false
    }

    const previousOwner = sessions.get(currentOwner)
    if (previousOwner?.jsonlPath === filePath) {
      previousOwner.jsonlPath = null
      previousOwner.lastSize = 0
      previousOwner.baselineSize = 0
      previousOwner.lastFileChangeAt = Date.now()
    }
  }

  if (entry.jsonlPath && entry.jsonlPath !== filePath) {
    coord.knownFiles.set(entry.jsonlPath, null)
  }

  coord.knownFiles.set(filePath, entry.sessionId)
  entry.jsonlPath = filePath
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
  if (!filePath || !sessions.has(entry.sessionId) || entry.jsonlPath === filePath) return false

  return assignFile(entry, coord, filePath, { forceTakeover: true })
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

function emitWorkState(entry: SessionEntry, nextState: ClaudeWorkState): void {
  if (nextState === entry.lastWorkState) return
  entry.lastWorkState = nextState
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
  if (nextState === 'idle') {
    void notifyIdleTransition(entry.sessionId, 'claude', entry.lastResponse || undefined)
  }
}

export function observeTerminalData(sessionId: string, data: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  const parsed = getClaudeWorkStateFromChunk(data, entry.titleRemainder)
  entry.titleRemainder = parsed.remainder

  if (parsed.state) {
    emitWorkState(entry, parsed.state)
  }
}

// --- Public API ---

export function watchSession(sessionId: string, cwd: string, claudePid?: number): void {
  // If already watching, update the PID for lsof retries and reset retry counter
  const existing = sessions.get(sessionId)
  if (existing) {
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
    lastResponse: '',
    lastWorkState: 'idle',
    titleRemainder: '',
    lastSize: 0,
    baselineSize: 0,
    createdAt: Date.now(),
    lastFileChangeAt: Date.now(),
    claudePid,
    lsofRetries: 0
  }
  sessions.set(sessionId, entry)

  const coord = getOrCreateCoordinator(projectDir)
  coord.sessionIds.add(sessionId)

  // Try to find the JSONL file via lsof (most reliable)
  if (claudePid) {
    refreshAssignmentFromPid(entry)
  }

  // NOTE: We do NOT fall back to mtime-based file guessing here.
  // With multiple Claude sessions sharing the same project directory,
  // guessing by mtime causes cross-session contamination. We rely on:
  // 1. lsof (above) for pre-existing files
  // 2. The coordinator's new-file detection for newly created files
}

export function unwatchSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return

  removeFromCoordinator(entry.projectDir, sessionId)
  sessions.delete(sessionId)
}

export function initClaudeWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function stopAllWatchers(): void {
  for (const [, coord] of coordinators) {
    clearInterval(coord.interval)
    coord.watcher?.close()
  }
  coordinators.clear()
  sessions.clear()
  mainWindow = null
}
