// apps/desktop/src/main/claude-transcript-tail.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { extractLastUserPrompt } from './claude-jsonl-prompts'
import { setLastUserMessage } from './last-user-message-store'

export function encodeCwdForClaudePath(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

interface WatchEntry {
  sessionId: string
  projectsDir: string
  watcher: fs.FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
}

const watchers = new Map<string, WatchEntry>()

function findNewestJsonl(projectsDir: string): string | null {
  if (!fs.existsSync(projectsDir)) return null
  const files = fs.readdirSync(projectsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length > 0 ? path.join(projectsDir, files[0].f) : null
}

function readAndPush(sessionId: string, projectsDir: string): void {
  const file = findNewestJsonl(projectsDir)
  if (!file) return
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return }
  const lines = text.split('\n')
  const prompt = extractLastUserPrompt(lines)
  if (prompt) setLastUserMessage(sessionId, prompt)
}

export function watchClaudeTranscript(
  sessionId: string,
  cwd: string,
  opts: { homeDir?: string } = {},
): void {
  const home = opts.homeDir ?? os.homedir()
  const projectsDir = path.join(home, '.claude', 'projects', encodeCwdForClaudePath(cwd))

  if (watchers.has(sessionId)) return

  const entry: WatchEntry = { sessionId, projectsDir, watcher: null, debounceTimer: null }
  watchers.set(sessionId, entry)

  // Initial read
  readAndPush(sessionId, projectsDir)

  if (!fs.existsSync(projectsDir)) {
    try { fs.mkdirSync(projectsDir, { recursive: true }) } catch {}
  }

  try {
    entry.watcher = fs.watch(projectsDir, { persistent: false }, () => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.debounceTimer = setTimeout(() => readAndPush(sessionId, projectsDir), 100)
    })
  } catch {
    // Directory not watchable; bail silently.
  }
}

export function unwatchClaudeTranscript(sessionId: string): void {
  const entry = watchers.get(sessionId)
  if (!entry) return
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.watcher?.close()
  watchers.delete(sessionId)
}

export function stopAllClaudeWatchers(): void {
  for (const id of [...watchers.keys()]) unwatchClaudeTranscript(id)
}
