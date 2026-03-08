// src/main/claude-session-watcher.ts
// Watches Claude Code JSONL session files to capture the last assistant response
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { BrowserWindow } from 'electron'

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

// Map sessionId → { watcher, lastResponse, cwdKey }
const watchers = new Map<string, {
  watcher: fs.FSWatcher | null
  jsonlPath: string | null
  lastResponse: string
  lastSize: number
}>()

let mainWindow: BrowserWindow | null = null

/** Encode a cwd path to Claude's project directory format: /foo/bar → -foo-bar */
function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/** Find the most recently modified JSONL file in a Claude project directory */
function findLatestJsonl(projectDir: string): string | null {
  try {
    const files = fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = path.join(projectDir, f)
        try {
          const stat = fs.statSync(fullPath)
          return { path: fullPath, mtime: stat.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean) as { path: string; mtime: number }[]

    if (files.length === 0) return null
    files.sort((a, b) => b.mtime - a.mtime)
    return files[0].path
  } catch {
    return null
  }
}

/** Parse the last assistant text response from a JSONL file (reads from end) */
function parseLastAssistantText(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    // Read last 64KB for efficiency
    const readSize = Math.min(stat.size, 64 * 1024)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize)
    fs.closeSync(fd)

    const text = buffer.toString('utf-8')
    const lines = text.split('\n').filter((l) => l.trim())

    // Walk backwards to find the last assistant message with text content
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type !== 'assistant') continue
        const content = entry.message?.content
        if (!Array.isArray(content)) continue

        // Collect all text blocks from this message
        const texts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            texts.push(block.text.trim())
          }
        }
        if (texts.length > 0) {
          return texts.join('\n')
        }
      } catch {
        continue
      }
    }
  } catch {}
  return ''
}

/** Start watching a session's Claude Code JSONL */
export function watchSession(sessionId: string, cwd: string): void {
  // Already watching this session
  if (watchers.has(sessionId)) return

  const projectKey = cwdToProjectDir(cwd)
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey)

  const entry: {
    watcher: fs.FSWatcher | null
    jsonlPath: string | null
    lastResponse: string
    lastSize: number
  } = {
    watcher: null,
    jsonlPath: null,
    lastResponse: '',
    lastSize: 0
  }
  watchers.set(sessionId, entry)

  const checkAndUpdate = () => {
    // Always find latest JSONL (new sessions may appear)
    const latestPath = findLatestJsonl(projectDir)
    if (!latestPath) return

    // Check if file changed
    try {
      const stat = fs.statSync(latestPath)
      if (latestPath === entry.jsonlPath && stat.size === entry.lastSize) return
      entry.jsonlPath = latestPath
      entry.lastSize = stat.size
    } catch {
      return
    }

    const response = parseLastAssistantText(latestPath)
    if (response && response !== entry.lastResponse) {
      entry.lastResponse = response
      // Clean and truncate for sidebar display
      const clean = response
        .replace(/```[\s\S]*?```/g, '[code]')  // collapse code blocks
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1))  // inline code → plain
        .replace(/\*\*([^*]+)\*\*/g, '$1')  // bold → plain
        .replace(/\*([^*]+)\*/g, '$1')  // italic → plain
        .replace(/^#+\s+/gm, '')  // strip heading markers
        .replace(/^[-*]\s+/gm, '')  // strip list markers
        .replace(/\n+/g, ' ')  // collapse newlines
        .trim()
        .slice(0, 200)
      if (clean && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-last-response', sessionId, clean)
      }
    }
  }

  // Initial check
  checkAndUpdate()

  // Watch the project directory for changes
  try {
    if (fs.existsSync(projectDir)) {
      entry.watcher = fs.watch(projectDir, { persistent: false }, () => {
        checkAndUpdate()
      })
      entry.watcher.on('error', () => {})
    }
  } catch {}

  // Also poll every 3s as fallback (fs.watch can miss events)
  const interval = setInterval(checkAndUpdate, 3000)
  const originalWatcher = entry.watcher
  entry.watcher = {
    close: () => {
      clearInterval(interval)
      originalWatcher?.close()
    }
  } as any
}

/** Stop watching a session */
export function unwatchSession(sessionId: string): void {
  const entry = watchers.get(sessionId)
  if (entry) {
    entry.watcher?.close()
    watchers.delete(sessionId)
  }
}

/** Initialize the watcher system with the main window */
export function initClaudeWatcher(window: BrowserWindow): void {
  mainWindow = window
}

/** Clean up all watchers */
export function stopAllWatchers(): void {
  for (const [, entry] of watchers) {
    entry.watcher?.close()
  }
  watchers.clear()
  mainWindow = null
}
