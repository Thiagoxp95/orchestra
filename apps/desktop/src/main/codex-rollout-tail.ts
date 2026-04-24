// apps/desktop/src/main/codex-rollout-tail.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentSessionState, NormalizedAgentSessionStatus } from '../shared/agent-session-types'
import { findCodexRolloutByDirectory } from './codex-rollout-files'
import type { CodexRolloutParseResult } from './codex-rollout-parser'
import { parseCodexRolloutLines } from './codex-rollout-parser'
import { setLastUserMessage } from './last-user-message-store'

const DISCOVERY_POLL_MS = 1000
const DISCOVERY_TIMEOUT_MS = 60_000
const READ_DEBOUNCE_MS = 150

type RolloutStatusUpdate = (status: NormalizedAgentSessionStatus) => void

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
  onStatusUpdate: RolloutStatusUpdate | null
  lastState: AgentSessionState | null
  lastResponsePreview: string
  lastTransitionAt: number
}

function rolloutWorkStateToAgentState(
  workState: CodexRolloutParseResult['workState'],
): AgentSessionState {
  switch (workState) {
    case 'working': return 'working'
    case 'waitingApproval': return 'waitingApproval'
    case 'waitingUserInput': return 'waitingUserInput'
    case 'idle': return 'idle'
  }
}

function emitRolloutStatus(entry: WatchEntry, result: CodexRolloutParseResult): void {
  if (!entry.onStatusUpdate) return
  const nextState = rolloutWorkStateToAgentState(result.workState)
  const nextPreview = result.lastResponse || ''
  if (nextState === entry.lastState && nextPreview === entry.lastResponsePreview) return

  const now = Date.now()
  const lastTransitionAt = entry.lastState === nextState
    ? (entry.lastTransitionAt || now)
    : now

  entry.lastState = nextState
  entry.lastResponsePreview = nextPreview
  entry.lastTransitionAt = lastTransitionAt

  entry.onStatusUpdate({
    sessionId: entry.sessionId,
    agent: 'codex',
    state: nextState,
    authority: 'codex-watcher-fallback',
    connected: true,
    lastResponsePreview: nextPreview,
    lastTransitionAt,
    updatedAt: now,
  })
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
  emitRolloutStatus(entry, result)
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
  opts: { rolloutRoot?: string; onStatusUpdate?: RolloutStatusUpdate } = {},
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
    onStatusUpdate: opts.onStatusUpdate ?? null,
    lastState: null,
    lastResponsePreview: '',
    lastTransitionAt: 0,
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
