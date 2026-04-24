// apps/desktop/src/main/codex-rollout-tail.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findCodexRolloutByDirectory } from './codex-rollout-files'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { setLastUserMessage } from './last-user-message-store'

const DISCOVERY_POLL_MS = 1000
const DISCOVERY_TIMEOUT_MS = 60_000
const READ_DEBOUNCE_MS = 150

interface WatchEntry {
  sessionId: string
  cwd: string
  sessionCreatedAt: number
  rolloutRoot: string
  discoveryTimer: NodeJS.Timeout | null
  discoveryDeadline: number
  watcher: fs.FSWatcher | null
  filePath: string | null
  debounceTimer: NodeJS.Timeout | null
}

const watchers = new Map<string, WatchEntry>()

function defaultRolloutRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
}

function readAndPush(entry: WatchEntry): void {
  if (!entry.filePath) return
  let text: string
  try {
    text = fs.readFileSync(entry.filePath, 'utf8')
  } catch {
    return
  }
  const lines = text.split('\n')
  const result = parseCodexRolloutLines(lines)
  if (result.lastUserPrompt) {
    setLastUserMessage(entry.sessionId, result.lastUserPrompt)
  }
}

function attachWatcher(entry: WatchEntry): void {
  if (!entry.filePath) return
  try {
    entry.watcher = fs.watch(entry.filePath, { persistent: false }, () => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => readAndPush(entry), READ_DEBOUNCE_MS)
    })
  } catch {
    // File not watchable; bail silently.
  }
  // Initial read after attach
  readAndPush(entry)
}

function pollForFile(entry: WatchEntry): void {
  if (!fs.existsSync(entry.rolloutRoot)) {
    if (Date.now() >= entry.discoveryDeadline) return
    entry.discoveryTimer = setTimeout(() => pollForFile(entry), DISCOVERY_POLL_MS)
    return
  }
  const match = findCodexRolloutByDirectory(entry.rolloutRoot, entry.cwd, entry.sessionCreatedAt)
  if (match) {
    entry.filePath = match.path
    entry.discoveryTimer = null
    attachWatcher(entry)
    return
  }
  if (Date.now() >= entry.discoveryDeadline) return
  entry.discoveryTimer = setTimeout(() => pollForFile(entry), DISCOVERY_POLL_MS)
}

export function watchCodexRollout(
  sessionId: string,
  cwd: string,
  sessionCreatedAt: number,
  opts: { rolloutRoot?: string } = {},
): void {
  if (watchers.has(sessionId)) return
  const entry: WatchEntry = {
    sessionId,
    cwd,
    sessionCreatedAt,
    rolloutRoot: opts.rolloutRoot ?? defaultRolloutRoot(),
    discoveryTimer: null,
    discoveryDeadline: Date.now() + DISCOVERY_TIMEOUT_MS,
    watcher: null,
    filePath: null,
    debounceTimer: null,
  }
  watchers.set(sessionId, entry)
  pollForFile(entry)
}

export function unwatchCodexRollout(sessionId: string): void {
  const entry = watchers.get(sessionId)
  if (!entry) return
  if (entry.discoveryTimer) clearTimeout(entry.discoveryTimer)
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher?.close()
  watchers.delete(sessionId)
}

export function stopAllCodexRolloutWatchers(): void {
  for (const id of [...watchers.keys()]) unwatchCodexRollout(id)
}
