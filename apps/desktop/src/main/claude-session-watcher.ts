// src/main/claude-session-watcher.ts
// Watches Claude Code JSONL session files to capture the last assistant response
// and determine Claude's activity state (idle/thinking/tool_executing)
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { BrowserWindow } from 'electron'

export type ClaudeActivityState = 'idle' | 'thinking' | 'tool_executing'

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

const MY_PID = process.pid

// Map sessionId → watcher state
const watchers = new Map<string, WatcherEntry>()

// In-process registry: JSONL file path → sessionId that claimed it.
// The filesystem lock only prevents cross-instance collisions (different PIDs);
// within the same process all sessions share MY_PID so we need this.
const claimedBySession = new Map<string, string>()

interface WatcherEntry {
  watcher: fs.FSWatcher | null
  jsonlPath: string | null
  lastResponse: string
  lastActivity: ClaudeActivityState
  lastSize: number
  /** Size of the file when we first claimed it — content before this is ignored */
  baselineSize: number
  /** Files that existed when we started watching — these belong to other sessions */
  existingFiles: Set<string>
}

let mainWindow: BrowserWindow | null = null

// --- Filesystem-level lock files for cross-instance coordination ---

function lockPath(jsonlPath: string): string {
  return jsonlPath + '.orchestra-lock'
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isLockedByOther(jsonlPath: string): boolean {
  const lp = lockPath(jsonlPath)
  try {
    const content = fs.readFileSync(lp, 'utf-8').trim()
    const pid = parseInt(content, 10)
    if (isNaN(pid) || pid === MY_PID) return false
    if (isPidAlive(pid)) return true
    // Stale lock — clean up
    try { fs.unlinkSync(lp) } catch {}
    return false
  } catch {
    return false
  }
}

function writeLock(jsonlPath: string): void {
  try { fs.writeFileSync(lockPath(jsonlPath), String(MY_PID), 'utf-8') } catch {}
}

function removeLock(jsonlPath: string): void {
  try {
    const content = fs.readFileSync(lockPath(jsonlPath), 'utf-8').trim()
    if (parseInt(content, 10) === MY_PID) fs.unlinkSync(lockPath(jsonlPath))
  } catch {}
}

// --- Helpers ---

function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

function getJsonlFiles(projectDir: string): { path: string; mtime: number; size: number }[] {
  try {
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = path.join(projectDir, f)
        try {
          const stat = fs.statSync(fullPath)
          return { path: fullPath, mtime: stat.mtimeMs, size: stat.size }
        } catch { return null }
      })
      .filter(Boolean) as { path: string; mtime: number; size: number }[]
  } catch {
    return []
  }
}

/**
 * Find a JSONL file that was CREATED after we started watching (not in existingFiles).
 * This is the primary matching strategy — ensures we never grab another session's file.
 */
function findNewJsonl(projectDir: string, existingFiles: Set<string>, sessionId: string): string | null {
  const files = getJsonlFiles(projectDir)
  // Sort by mtime desc — newest first
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files) {
    if (existingFiles.has(f.path)) continue
    if (isLockedByOther(f.path)) continue
    // Skip files already claimed by another session in this process
    const owner = claimedBySession.get(f.path)
    if (owner && owner !== sessionId) continue
    return f.path
  }
  return null
}

// --- JSONL parsing ---

interface ParseResult {
  lastResponse: string
  activity: ClaudeActivityState
}

function parseJsonlTail(filePath: string, afterOffset: number): ParseResult {
  const result: ParseResult = { lastResponse: '', activity: 'idle' }

  try {
    const stat = fs.statSync(filePath)
    const readFrom = Math.max(afterOffset, stat.size - 64 * 1024)
    const readSize = stat.size - readFrom
    if (readSize <= 0) return result

    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, readFrom)
    fs.closeSync(fd)

    const text = buffer.toString('utf-8')
    const lines = text.split('\n').filter((l) => l.trim())

    let activityDetermined = false
    let responseDetermined = false

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])

        if (!activityDetermined) {
          // 'progress' entries are written during subagent execution (e.g. Explore)
          // — treat them as active tool execution
          if (entry.type === 'progress') {
            result.activity = 'tool_executing'
            activityDetermined = true
          } else if (entry.type === 'user') {
            const content = entry.message?.content
            if (Array.isArray(content) || typeof content === 'string') {
              result.activity = 'thinking'
              activityDetermined = true
            }
          } else if (entry.type === 'assistant') {
            const stopReason = entry.message?.stop_reason
            const content = entry.message?.content
            if (stopReason === 'end_turn') {
              result.activity = 'idle'
              activityDetermined = true
            } else if (stopReason === 'tool_use' || (Array.isArray(content) && content.some((b: any) => b.type === 'tool_use'))) {
              result.activity = 'tool_executing'
              activityDetermined = true
            } else if (!stopReason) {
              result.activity = 'thinking'
              activityDetermined = true
            }
          }
        }

        if (!responseDetermined && entry.type === 'assistant') {
          if (entry.message?.stop_reason === 'end_turn') {
            const content = entry.message?.content
            if (Array.isArray(content)) {
              const texts: string[] = []
              for (const block of content) {
                if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
              }
              if (texts.length > 0) {
                result.lastResponse = texts.join('\n')
                responseDetermined = true
              }
            }
          }
        }

        if (activityDetermined && responseDetermined) break
      } catch { continue }
    }
  } catch {}

  return result
}

function cleanForDisplay(response: string): string {
  return response
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 200)
}

// --- Session watching ---

export function watchSession(sessionId: string, cwd: string): void {
  if (watchers.has(sessionId)) return

  const projectKey = cwdToProjectDir(cwd)
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey)

  // Snapshot ALL existing JSONL files — these belong to other sessions, never match them
  const existingFiles = new Set<string>()
  try {
    for (const f of getJsonlFiles(projectDir)) {
      existingFiles.add(f.path)
    }
  } catch {}

  const entry: WatcherEntry = {
    watcher: null,
    jsonlPath: null,
    lastResponse: '',
    lastActivity: 'idle',
    lastSize: 0,
    baselineSize: 0,
    existingFiles
  }
  watchers.set(sessionId, entry)

  const claimFile = (filePath: string): boolean => {
    try {
      const stat = fs.statSync(filePath)
      entry.jsonlPath = filePath
      entry.baselineSize = stat.size
      entry.lastSize = stat.size
      writeLock(filePath)
      claimedBySession.set(filePath, sessionId)
      return true
    } catch { return false }
  }

  const releaseClaim = () => {
    if (entry.jsonlPath) {
      removeLock(entry.jsonlPath)
      claimedBySession.delete(entry.jsonlPath)
      entry.jsonlPath = null
    }
    entry.lastSize = 0
    entry.baselineSize = 0
  }

  const checkAndUpdate = () => {
    let targetPath = entry.jsonlPath

    if (!targetPath) {
      // Look for a NEW file (created after we started watching)
      targetPath = findNewJsonl(projectDir, entry.existingFiles, sessionId)
      if (!targetPath) return
      if (!claimFile(targetPath)) return
      // Don't parse yet — wait for content to grow beyond baseline
      return
    } else {
      // Check if our file disappeared or if Claude restarted (new file appeared)
      try {
        fs.statSync(targetPath)
      } catch {
        // File gone — release and look for new one
        releaseClaim()
        return
      }
      // Check for a newer file (Claude restarted in this terminal)
      const newerPath = findNewJsonl(projectDir, entry.existingFiles, sessionId)
      if (newerPath && newerPath !== targetPath) {
        // A newer file appeared — switch to it
        releaseClaim()
        if (!claimFile(newerPath)) return
        targetPath = newerPath
        return
      }
    }

    // Check if file grew
    try {
      const stat = fs.statSync(targetPath)
      if (stat.size === entry.lastSize) return
      entry.lastSize = stat.size
    } catch { return }

    const { lastResponse, activity } = parseJsonlTail(targetPath, entry.baselineSize)

    if (activity !== entry.lastActivity) {
      entry.lastActivity = activity
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-activity', sessionId, activity)
        const processStatus = activity === 'idle' ? 'terminal' : 'claude'
        mainWindow.webContents.send('process-change', sessionId, processStatus)
      }
    }

    if (lastResponse && lastResponse !== entry.lastResponse) {
      entry.lastResponse = lastResponse
      const clean = cleanForDisplay(lastResponse)
      if (clean && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-last-response', sessionId, clean)
      }
    }
  }

  // Initial check
  checkAndUpdate()

  // Watch the project directory for new files / changes
  try {
    if (fs.existsSync(projectDir)) {
      entry.watcher = fs.watch(projectDir, { persistent: false }, () => {
        checkAndUpdate()
      })
      entry.watcher.on('error', () => {})
    }
  } catch {}

  // Poll every 2s as fallback
  const interval = setInterval(checkAndUpdate, 2000)
  const originalWatcher = entry.watcher
  entry.watcher = {
    close: () => {
      clearInterval(interval)
      originalWatcher?.close()
    }
  } as any
}

export function unwatchSession(sessionId: string): void {
  const entry = watchers.get(sessionId)
  if (entry) {
    entry.watcher?.close()
    if (entry.jsonlPath) {
      removeLock(entry.jsonlPath)
      claimedBySession.delete(entry.jsonlPath)
    }
    watchers.delete(sessionId)
  }
}

export function initClaudeWatcher(window: BrowserWindow): void {
  mainWindow = window
}

export function stopAllWatchers(): void {
  for (const [, entry] of watchers) {
    entry.watcher?.close()
    if (entry.jsonlPath) removeLock(entry.jsonlPath)
  }
  watchers.clear()
  claimedBySession.clear()
  mainWindow = null
}
