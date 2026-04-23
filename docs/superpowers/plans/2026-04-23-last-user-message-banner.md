# Last User Message Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the most recent user message in every Claude/Codex agent session as a thin banner above the terminal pane.

**Architecture:** Main process tails Claude JSONL and reuses Codex rollout parser to extract the latest genuine user message per session. A central `last-user-message-store` deduplicates and broadcasts changes via IPC. Renderer subscribes, stores per-session in zustand, and renders a sticky single-line banner above each session's terminal.

**Tech Stack:** Electron main process (Node fs/watch), TypeScript, IPC via `mainWindow.webContents.send`, React 19 + zustand (renderer), Tailwind v4 for styling, vitest/jest for tests.

---

## File Structure

**Created:**
- `apps/desktop/src/main/claude-jsonl-prompts.ts` — pure extractor for the latest user prompt from Claude JSONL entries
- `apps/desktop/src/main/claude-jsonl-prompts.test.ts`
- `apps/desktop/src/main/claude-transcript-tail.ts` — discovers the active JSONL transcript for a session cwd and tails new lines
- `apps/desktop/src/main/claude-transcript-tail.test.ts`
- `apps/desktop/src/main/last-user-message-store.ts` — central in-memory store + broadcaster
- `apps/desktop/src/main/last-user-message-store.test.ts`
- `apps/desktop/src/renderer/src/stores/lastMessageStore.ts` — zustand store for per-session banner text
- `apps/desktop/src/renderer/src/components/LastMessageBanner.tsx`
- `apps/desktop/src/renderer/src/components/LastMessageBanner.test.tsx`

**Modified:**
- `apps/desktop/src/shared/types.ts` — add `LastUserMessageEvent` type
- `apps/desktop/src/main/index.ts` — wire watcher start/stop on session create/close; install IPC bridge
- `apps/desktop/src/main/codex-rollout-parser.ts` — already returns `lastUserPrompt`; add a thin caller that pushes into the store whenever Codex rollout lines are parsed (find call site during Task 5)
- `apps/desktop/src/preload/index.ts` — expose `onSessionLastUserMessage(handler)`
- `apps/desktop/src/renderer/src/env.d.ts` — type the new preload method
- `apps/desktop/src/renderer/src/App.tsx` — subscribe to `session:last-user-message` once at mount
- `apps/desktop/src/renderer/src/components/SessionItem.tsx` — render `<LastMessageBanner sessionId=… />` above the terminal container

---

## Task 1: Claude JSONL prompt extractor

**Files:**
- Create: `apps/desktop/src/main/claude-jsonl-prompts.ts`
- Test: `apps/desktop/src/main/claude-jsonl-prompts.test.ts`

This is a pure function — no fs, no watching. Reads parsed JSONL entries and returns the most recent genuine user prompt text, ignoring tool-result entries and stripping `<system-reminder>` blocks.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/claude-jsonl-prompts.test.ts
import { describe, it, expect } from 'vitest'
import { extractLastUserPrompt } from './claude-jsonl-prompts'

describe('extractLastUserPrompt', () => {
  it('returns the last plain user text', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'second prompt' } }),
    ]
    expect(extractLastUserPrompt(lines)).toBe('second prompt')
  })

  it('skips tool_result entries', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'real prompt' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }),
    ]
    expect(extractLastUserPrompt(lines)).toBe('real prompt')
  })

  it('strips <system-reminder>...</system-reminder> blocks', () => {
    const content = '<system-reminder>be careful</system-reminder>\n\nactual user text'
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBe('actual user text')
  })

  it('returns null when only system-reminder content present', () => {
    const content = '<system-reminder>only this</system-reminder>'
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBeNull()
  })

  it('handles array content with text blocks', () => {
    const content = [{ type: 'text', text: 'block prompt' }]
    const lines = [JSON.stringify({ type: 'user', message: { content } })]
    expect(extractLastUserPrompt(lines)).toBe('block prompt')
  })

  it('returns null on empty input', () => {
    expect(extractLastUserPrompt([])).toBeNull()
  })

  it('ignores malformed JSON lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'user', message: { content: 'good' } })]
    expect(extractLastUserPrompt(lines)).toBe('good')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/main/claude-jsonl-prompts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/claude-jsonl-prompts.ts
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

function extractTextFromEntry(entry: any): string | null {
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content

  if (typeof content === 'string') {
    const cleaned = stripSystemReminders(content)
    return cleaned.length > 0 ? cleaned : null
  }

  if (!Array.isArray(content)) return null

  const textParts: string[] = []
  for (const item of content) {
    if (item?.type === 'tool_result') return null
    if (typeof item === 'string') textParts.push(item)
    else if (item?.type === 'text' && typeof item.text === 'string') textParts.push(item.text)
  }
  if (textParts.length === 0) return null
  const cleaned = stripSystemReminders(textParts.join('\n'))
  return cleaned.length > 0 ? cleaned : null
}

export function extractLastUserPrompt(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    const text = extractTextFromEntry(entry)
    if (text) return text
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && bun test src/main/claude-jsonl-prompts.test.ts`
Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/claude-jsonl-prompts.ts apps/desktop/src/main/claude-jsonl-prompts.test.ts
git commit -m "feat(banner): claude jsonl last-user-prompt extractor"
```

---

## Task 2: Central last-user-message store + broadcaster

**Files:**
- Create: `apps/desktop/src/main/last-user-message-store.ts`
- Test: `apps/desktop/src/main/last-user-message-store.test.ts`

In-memory `Map<sessionId, {text, timestamp}>`. Public API: `setLastUserMessage(sessionId, text)`, `getLastUserMessage(sessionId)`, `clearSession(sessionId)`, `subscribe(handler)`. Dedupes by text equality (no re-broadcast if unchanged).

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/last-user-message-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setLastUserMessage,
  getLastUserMessage,
  clearSession,
  subscribe,
  __resetForTests,
} from './last-user-message-store'

describe('last-user-message-store', () => {
  beforeEach(() => __resetForTests())

  it('stores and retrieves the message', () => {
    setLastUserMessage('s1', 'hello')
    expect(getLastUserMessage('s1')?.text).toBe('hello')
  })

  it('notifies subscribers on change', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'hello')
    expect(handler).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello', timestamp: expect.any(Number) })
  })

  it('does not re-broadcast when text is unchanged', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'hello')
    setLastUserMessage('s1', 'hello')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('broadcasts when text changes', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', 'a')
    setLastUserMessage('s1', 'b')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('clearSession removes entry', () => {
    setLastUserMessage('s1', 'hello')
    clearSession('s1')
    expect(getLastUserMessage('s1')).toBeUndefined()
  })

  it('ignores empty/null text', () => {
    const handler = vi.fn()
    subscribe(handler)
    setLastUserMessage('s1', '')
    expect(handler).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd apps/desktop && bun test src/main/last-user-message-store.test.ts`

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/last-user-message-store.ts
export interface LastUserMessageEntry {
  sessionId: string
  text: string
  timestamp: number
}

type Handler = (entry: LastUserMessageEntry) => void

const entries = new Map<string, LastUserMessageEntry>()
const handlers = new Set<Handler>()

export function setLastUserMessage(sessionId: string, text: string): void {
  if (!text) return
  const existing = entries.get(sessionId)
  if (existing && existing.text === text) return
  const entry: LastUserMessageEntry = { sessionId, text, timestamp: Date.now() }
  entries.set(sessionId, entry)
  for (const h of handlers) h(entry)
}

export function getLastUserMessage(sessionId: string): LastUserMessageEntry | undefined {
  return entries.get(sessionId)
}

export function clearSession(sessionId: string): void {
  entries.delete(sessionId)
}

export function subscribe(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function __resetForTests(): void {
  entries.clear()
  handlers.clear()
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/last-user-message-store.ts apps/desktop/src/main/last-user-message-store.test.ts
git commit -m "feat(banner): central last-user-message store with broadcast"
```

---

## Task 3: Claude transcript file tailer

**Files:**
- Create: `apps/desktop/src/main/claude-transcript-tail.ts`
- Test: `apps/desktop/src/main/claude-transcript-tail.test.ts`

Watches a session's Claude transcript directory (`~/.claude/projects/<encoded-cwd>/`) and tails the newest `*.jsonl` file. On change, reads the file, calls `extractLastUserPrompt`, and pushes into `last-user-message-store`. Uses `fs.watch` (lightweight) with debounced re-reads.

Encoding rule: `~/.claude/projects/` directory names are the cwd with `/` replaced by `-` (e.g. `/Users/txp/Pessoal/orchestra` → `-Users-txp-Pessoal-orchestra`). This matches the actual user-memory path in this repo's MEMORY.md.

- [ ] **Step 1: Write failing test**

```ts
// apps/desktop/src/main/claude-transcript-tail.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeCwdForClaudePath, watchClaudeTranscript, stopAllClaudeWatchers } from './claude-transcript-tail'
import { __resetForTests, getLastUserMessage } from './last-user-message-store'

describe('encodeCwdForClaudePath', () => {
  it('replaces slashes with dashes', () => {
    expect(encodeCwdForClaudePath('/Users/txp/Pessoal/orchestra')).toBe('-Users-txp-Pessoal-orchestra')
  })
})

describe('watchClaudeTranscript', () => {
  let tmpRoot: string
  let cwd: string
  let projectsDir: string

  beforeEach(() => {
    __resetForTests()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-claude-'))
    cwd = path.join(tmpRoot, 'project')
    fs.mkdirSync(cwd, { recursive: true })
    projectsDir = path.join(tmpRoot, '.claude', 'projects', encodeCwdForClaudePath(cwd))
    fs.mkdirSync(projectsDir, { recursive: true })
  })

  afterEach(() => {
    stopAllClaudeWatchers()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('detects last user prompt in newest jsonl and pushes to store', async () => {
    const file = path.join(projectsDir, 'a.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello world' } }) + '\n')

    watchClaudeTranscript('s1', cwd, { homeDir: tmpRoot })
    // initial read is synchronous-ish; allow fs.watch debounce
    await new Promise((r) => setTimeout(r, 50))

    expect(getLastUserMessage('s1')?.text).toBe('hello world')
  })

  it('updates when file gains a new user message', async () => {
    const file = path.join(projectsDir, 'a.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'first' } }) + '\n')
    watchClaudeTranscript('s1', cwd, { homeDir: tmpRoot })
    await new Promise((r) => setTimeout(r, 50))

    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'second' } }) + '\n')
    await new Promise((r) => setTimeout(r, 250))

    expect(getLastUserMessage('s1')?.text).toBe('second')
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
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
    // Watch parent for projects dir creation; for simplicity, poll once via watcher on home/.claude if missing.
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
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/claude-transcript-tail.ts apps/desktop/src/main/claude-transcript-tail.test.ts
git commit -m "feat(banner): claude transcript jsonl tailer"
```

---

## Task 4: IPC bridge — preload + types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/env.d.ts`

- [ ] **Step 1: Add the event type**

In `apps/desktop/src/shared/types.ts`, add at the bottom:

```ts
export interface LastUserMessageEvent {
  sessionId: string
  text: string
  timestamp: number
}
```

- [ ] **Step 2: Expose in preload**

In `apps/desktop/src/preload/index.ts`, find the existing `contextBridge.exposeInMainWorld('electronAPI', { ... })` block and add (next to the other `on*` subscription methods):

```ts
onSessionLastUserMessage: (handler: (event: import('../shared/types').LastUserMessageEvent) => void) => {
  const listener = (_e: unknown, payload: import('../shared/types').LastUserMessageEvent) => handler(payload)
  ipcRenderer.on('session:last-user-message', listener)
  return () => ipcRenderer.removeListener('session:last-user-message', listener)
},
```

(If preload uses a typed `Api` interface above the bridge call, add the same signature there.)

- [ ] **Step 3: Add to renderer types**

In `apps/desktop/src/renderer/src/env.d.ts`, add to the `electronAPI` interface:

```ts
onSessionLastUserMessage: (
  handler: (event: import('../../shared/types').LastUserMessageEvent) => void
) => () => void
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && bun run typecheck` (or `tsc -p .` whichever the repo uses — check `package.json` scripts).
Expected: no new TS errors related to the additions.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/env.d.ts
git commit -m "feat(banner): IPC bridge for last-user-message events"
```

---

## Task 5: Wire watchers and broadcast in main process

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

The store's `subscribe` produces events that must be forwarded to the active `BrowserWindow`. We also need to start the Claude tailer when a Claude session is created and stop it when it closes. For Codex, we hook into the existing `emitCodexNormalizedStatus` flow (lines 84–116 of `index.ts`) — and into wherever Codex rollout-line parsing produces `lastUserPrompt`.

- [ ] **Step 1: Find Codex rollout consumer**

Run: `grep -rn "parseCodexRolloutLines\|applyEventMessage" apps/desktop/src/main/ | grep -v test | grep -v "\.js:"`

Identify the function that ingests Codex rollout lines (likely in `codex-app-server-manager.ts`, `codex-watch-registration.ts`, or similar). After every parse call, push `result.lastUserPrompt` (when non-empty) into the store:

```ts
import { setLastUserMessage } from './last-user-message-store'
// after parseCodexRolloutLines(...) returns `result`
if (result.lastUserPrompt) setLastUserMessage(sessionId, result.lastUserPrompt)
```

If no Codex consumer of `parseCodexRolloutLines` exists yet (the helper might be currently unused), defer this hookup and document it as a TODO comment in `index.ts`. The Claude side will still ship.

- [ ] **Step 2: Add subscription in main**

In `apps/desktop/src/main/index.ts`, near the top imports add:

```ts
import { subscribe as subscribeLastUserMessage } from './last-user-message-store'
import { watchClaudeTranscript, unwatchClaudeTranscript } from './claude-transcript-tail'
```

After `mainWindow` is created in `createWindow`, after the existing event wiring, add:

```ts
const unsubscribeLastMsg = subscribeLastUserMessage((entry) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('session:last-user-message', entry)
})
mainWindow.on('closed', () => unsubscribeLastMsg())
```

- [ ] **Step 3: Start/stop Claude watcher per session**

Find the existing session lifecycle handlers in `index.ts` (search for `session:create`, `session:close`, `ipcMain.handle('session:`...). For each Claude-type session created, call `watchClaudeTranscript(sessionId, cwd)`. For each session closed, call `unwatchClaudeTranscript(sessionId)` and `clearSession(sessionId)` from the store.

If sessions can change agent type at runtime, hook the watcher to start whenever the session reports `processStatus === 'claude'` (look at `daemon-client.ts` for the status events).

```ts
import { clearSession } from './last-user-message-store'
// inside session creation handler, when agent is claude:
watchClaudeTranscript(sessionId, cwd)
// inside session close handler:
unwatchClaudeTranscript(sessionId)
clearSession(sessionId)
```

- [ ] **Step 4: Manual sanity build**

Run: `cd apps/desktop && bun run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(banner): wire claude/codex last-user-message watchers in main"
```

---

## Task 6: Renderer zustand store

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/lastMessageStore.ts`

- [ ] **Step 1: Implement**

```ts
// apps/desktop/src/renderer/src/stores/lastMessageStore.ts
import { create } from 'zustand'
import type { LastUserMessageEvent } from '../../../shared/types'

interface LastMessageState {
  bySession: Record<string, { text: string; timestamp: number }>
  set: (event: LastUserMessageEvent) => void
  clear: (sessionId: string) => void
}

export const useLastMessageStore = create<LastMessageState>((set) => ({
  bySession: {},
  set: (event) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [event.sessionId]: { text: event.text, timestamp: event.timestamp },
      },
    })),
  clear: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.bySession
      return { bySession: rest }
    }),
}))
```

- [ ] **Step 2: Subscribe in App.tsx**

In `apps/desktop/src/renderer/src/App.tsx`, near the existing `useEffect` blocks that set up IPC subscriptions, add:

```tsx
import { useLastMessageStore } from './stores/lastMessageStore'

// inside App component:
useEffect(() => {
  const unsub = window.electronAPI.onSessionLastUserMessage((event) => {
    useLastMessageStore.getState().set(event)
  })
  return unsub
}, [])
```

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/lastMessageStore.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(banner): renderer last-message store + IPC subscription"
```

---

## Task 7: Banner component + mount in SessionItem

**Files:**
- Create: `apps/desktop/src/renderer/src/components/LastMessageBanner.tsx`
- Create: `apps/desktop/src/renderer/src/components/LastMessageBanner.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/SessionItem.tsx`

- [ ] **Step 1: Failing component test**

```tsx
// apps/desktop/src/renderer/src/components/LastMessageBanner.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LastMessageBanner } from './LastMessageBanner'
import { useLastMessageStore } from '../stores/lastMessageStore'

describe('LastMessageBanner', () => {
  it('renders nothing when no message', () => {
    useLastMessageStore.setState({ bySession: {} })
    const { container } = render(<LastMessageBanner sessionId="s1" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the truncated message text', () => {
    useLastMessageStore.setState({ bySession: { s1: { text: 'hello world', timestamp: 1 } } })
    render(<LastMessageBanner sessionId="s1" />)
    expect(screen.getByText(/hello world/)).toBeInTheDocument()
  })

  it('expands on click', () => {
    useLastMessageStore.setState({ bySession: { s1: { text: 'long message', timestamp: 1 } } })
    render(<LastMessageBanner sessionId="s1" />)
    const banner = screen.getByRole('button')
    fireEvent.click(banner)
    expect(banner).toHaveAttribute('aria-expanded', 'true')
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd apps/desktop && bun test src/renderer/src/components/LastMessageBanner.test.tsx`

- [ ] **Step 3: Implement component**

```tsx
// apps/desktop/src/renderer/src/components/LastMessageBanner.tsx
import { useState } from 'react'
import { useLastMessageStore } from '../stores/lastMessageStore'

interface Props {
  sessionId: string
  accentColor?: string
}

export function LastMessageBanner({ sessionId, accentColor }: Props) {
  const entry = useLastMessageStore((s) => s.bySession[sessionId])
  const [expanded, setExpanded] = useState(false)
  if (!entry) return null

  const bg = accentColor ? `${accentColor}22` : 'rgba(255,255,255,0.04)'
  const border = accentColor ? `${accentColor}55` : 'rgba(255,255,255,0.08)'

  return (
    <button
      type="button"
      role="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      title={entry.text}
      className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 border-b cursor-pointer"
      style={{ background: bg, borderColor: border }}
    >
      <span className="opacity-60 mr-2">you said:</span>
      <span
        className={expanded ? 'whitespace-pre-wrap block max-h-32 overflow-y-auto' : 'truncate inline-block align-bottom max-w-[calc(100%-5rem)]'}
      >
        {entry.text}
      </span>
    </button>
  )
}
```

- [ ] **Step 4: Run, verify PASS**

- [ ] **Step 5: Mount above terminal**

Open `apps/desktop/src/renderer/src/components/SessionItem.tsx`. Locate the JSX node that wraps the xterm container (the element that hosts the terminal — likely a `<div>` with a ref, near where xterm is attached). Render the banner immediately above that container:

```tsx
import { LastMessageBanner } from './LastMessageBanner'
// at the top of the returned JSX, just inside the outer wrapper:
<LastMessageBanner sessionId={session.id} accentColor={workspaceColor} />
```

Use whichever variable already holds the workspace color in this component (likely passed as a prop or read from a workspaces store). If unavailable, omit the prop.

- [ ] **Step 6: Type-check + build**

Run: `cd apps/desktop && bun run typecheck && bun run build`

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/LastMessageBanner.tsx apps/desktop/src/renderer/src/components/LastMessageBanner.test.tsx apps/desktop/src/renderer/src/components/SessionItem.tsx
git commit -m "feat(banner): LastMessageBanner component mounted in SessionItem"
```

---

## Task 8: Manual end-to-end verification

- [ ] **Step 1: Launch the dev app**

Run: `cd apps/desktop && bun run dev`

- [ ] **Step 2: Open a Claude session**

Open a terminal session in any workspace and start `claude`. Type a prompt and press Enter.

- [ ] **Step 3: Verify the banner**

Within ~1 second of submitting, the banner should appear above the terminal showing "you said: <your prompt>" truncated to one line. Click to expand. Send a second prompt — banner should update to the new text.

- [ ] **Step 4: Open a Codex session**

Repeat with `codex`. Verify the banner updates with each user prompt. (If Task 5 Step 1 deferred Codex hookup, this step is expected to fail for Codex — note it as follow-up.)

- [ ] **Step 5: Close + reopen session**

Close the session, reopen a new one in the same workspace. Banner starts empty until a new message is sent.

---

## Notes for the Implementer

- The `accentColor` prop in `LastMessageBanner` accepts a hex string like `#7e22ce`. The component appends `22` (hex alpha ~13%) for the bg and `55` for the border — adjust if it looks wrong against the dark theme (`#1a1a2e`).
- The `fs.watch` API is platform-dependent — on macOS it may emit `rename` events when files are recreated. The 100 ms debounce + full re-read pattern is robust against this.
- If you find the Claude transcript directory doesn't exist at session start (Claude hasn't written yet), the watcher silently no-ops; the next file event will pick it up once the directory is created. If watching the parent isn't reliable, fall back to a 1-second polling timer that calls `readAndPush` until the directory exists, then attaches `fs.watch`.
- Codex session ID comes from the codex side and may not match the orchestra session ID. If Codex sessions push to the store using their own ID, the renderer banner won't find them. Map Codex sessionId → orchestra sessionId at the Codex consumer site (the codex-app-server-manager already keeps this mapping for status events — reuse it).
