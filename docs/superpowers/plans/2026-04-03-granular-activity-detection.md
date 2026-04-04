# Granular Activity Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect granular agent activity states (thinking, tool_executing, permission_request, stalled, interrupted, turn_complete) by intercepting OSC terminal title animations and pattern-matching terminal buffer content.

**Architecture:** A `terminal-title-tracker` intercepts OSC title sequences from raw pty data before ANSI stripping. An `activity-classifier` pure function pattern-matches the stripped buffer to identify sub-states. The existing `terminal-activity-detector` integrates both to emit granular `ActivityState` values instead of binary working/idle.

**Tech Stack:** Electron IPC, vitest, TypeScript

---

### Task 1: Create the ActivityState type

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add ActivityState type**

In `apps/desktop/src/shared/types.ts`, add after the `ProcessStatus` type (around line 59):

```typescript
export type ActivityState =
  | 'idle'
  | 'interrupted'
  | 'permission_request'
  | 'stalled'
  | 'thinking'
  | 'tool_executing'
  | 'turn_complete'
  | 'working'
```

- [ ] **Step 2: Update the `onSessionWorkState` signature in ElectronAPI**

Find the `onSessionWorkState` line in the `ElectronAPI` interface and change:

```typescript
// Before
onSessionWorkState: (callback: (sessionId: string, state: 'working' | 'idle') => void) => () => void
// After
onSessionWorkState: (callback: (sessionId: string, state: ActivityState) => void) => () => void
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat: add ActivityState type"
```

---

### Task 2: Create terminal-title-tracker module

**Files:**
- Create: `apps/desktop/src/main/terminal-title-tracker.ts`
- Create: `apps/desktop/src/main/terminal-title-tracker.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// apps/desktop/src/main/terminal-title-tracker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  feedRawData,
  isTitleAnimating,
  getLastTitle,
  clearSession,
  clearAll,
} from './terminal-title-tracker'

describe('terminal-title-tracker', () => {
  beforeEach(() => {
    clearAll()
  })

  afterEach(() => {
    clearAll()
  })

  it('extracts OSC 0 title from raw data', () => {
    feedRawData('s1', '\x1b]0;My Title\x07')
    expect(getLastTitle('s1')).toBe('My Title')
  })

  it('extracts OSC 2 title from raw data', () => {
    feedRawData('s1', '\x1b]2;Window Title\x07')
    expect(getLastTitle('s1')).toBe('Window Title')
  })

  it('extracts title terminated by ST (ESC backslash)', () => {
    feedRawData('s1', '\x1b]0;Title ST\x1b\\')
    expect(getLastTitle('s1')).toBe('Title ST')
  })

  it('extracts title embedded in other data', () => {
    feedRawData('s1', 'some text\x1b]0;Embedded\x07more text')
    expect(getLastTitle('s1')).toBe('Embedded')
  })

  it('detects title animation when title changes rapidly', () => {
    feedRawData('s1', '\x1b]0;⠂ Claude\x07')
    feedRawData('s1', '\x1b]0;⠐ Claude\x07')
    expect(isTitleAnimating('s1')).toBe(true)
  })

  it('returns false for animation when title has not changed', () => {
    feedRawData('s1', '\x1b]0;Static Title\x07')
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('returns false for animation when no title set', () => {
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('detects animation stopping after timeout', () => {
    vi.useFakeTimers()
    feedRawData('s1', '\x1b]0;⠂ Claude\x07')
    feedRawData('s1', '\x1b]0;⠐ Claude\x07')
    expect(isTitleAnimating('s1')).toBe(true)

    vi.advanceTimersByTime(1500)
    expect(isTitleAnimating('s1')).toBe(false)
    vi.useRealTimers()
  })

  it('clears session data', () => {
    feedRawData('s1', '\x1b]0;Title\x07')
    clearSession('s1')
    expect(getLastTitle('s1')).toBe('')
    expect(isTitleAnimating('s1')).toBe(false)
  })

  it('handles multiple titles in one chunk', () => {
    feedRawData('s1', '\x1b]0;First\x07text\x1b]0;Second\x07')
    expect(getLastTitle('s1')).toBe('Second')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/terminal-title-tracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/main/terminal-title-tracker.ts
// Extracts terminal title from OSC 0/2 escape sequences in raw pty data.
// Tracks whether the title is actively animating (changing rapidly).

const TITLE_ANIMATION_WINDOW_MS = 1_000

// Matches OSC 0 or 2 terminated by BEL (\x07) or ST (\x1b\\)
const OSC_TITLE_RE = /\x1b\]([02]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

interface TitleState {
  lastTitle: string
  prevTitle: string
  lastChangeAt: number
}

const sessions = new Map<string, TitleState>()

function getOrCreate(sessionId: string): TitleState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { lastTitle: '', prevTitle: '', lastChangeAt: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

export function feedRawData(sessionId: string, rawData: string): void {
  const state = getOrCreate(sessionId)

  let match: RegExpExecArray | null
  OSC_TITLE_RE.lastIndex = 0
  while ((match = OSC_TITLE_RE.exec(rawData)) !== null) {
    const title = match[2]
    if (title !== state.lastTitle) {
      state.prevTitle = state.lastTitle
      state.lastTitle = title
      state.lastChangeAt = Date.now()
    }
  }
}

export function isTitleAnimating(sessionId: string): boolean {
  const state = sessions.get(sessionId)
  if (!state) return false
  if (!state.prevTitle && !state.lastTitle) return false
  // Title is "animating" if it changed at least once and the last change was recent
  if (state.prevTitle === '' && state.lastChangeAt === 0) return false
  return (Date.now() - state.lastChangeAt) < TITLE_ANIMATION_WINDOW_MS
}

export function getLastTitle(sessionId: string): string {
  return sessions.get(sessionId)?.lastTitle ?? ''
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function clearAll(): void {
  sessions.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/terminal-title-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/terminal-title-tracker.ts apps/desktop/src/main/terminal-title-tracker.test.ts
git commit -m "feat: add terminal-title-tracker module"
```

---

### Task 3: Hook title tracker into raw pty data

**Files:**
- Modify: `apps/desktop/src/main/terminal-output-buffer.ts`

- [ ] **Step 1: Add raw data hook to terminal-output-buffer**

In `apps/desktop/src/main/terminal-output-buffer.ts`, add a hook mechanism. After the `let emitTimer` line (line 27), add:

```typescript
type RawDataHook = (sessionId: string, rawData: string) => void
const rawDataHooks: RawDataHook[] = []

export function onRawTerminalData(hook: RawDataHook): void {
  rawDataHooks.push(hook)
}
```

In `feedTerminalOutput` (line 84), add at the very start of the function body (before the buffer logic):

```typescript
for (const hook of rawDataHooks) {
  hook(sessionId, data)
}
```

Also add cleanup in `stopTerminalOutputBuffer`:

```typescript
rawDataHooks.length = 0
```

- [ ] **Step 2: Wire title tracker in main/index.ts**

In `apps/desktop/src/main/index.ts`, add import:

```typescript
import { feedRawData as feedTitleData, clearSession as clearTitleSession } from './terminal-title-tracker'
import { onRawTerminalData } from './terminal-output-buffer'
```

After `initTerminalOutputBuffer(mainWindow)`, add:

```typescript
onRawTerminalData(feedTitleData)
```

Note: `onRawTerminalData` is already imported path — just need to add the import for `onRawTerminalData` from `./terminal-output-buffer`. The existing import line is:
```typescript
import { initTerminalOutputBuffer, stopTerminalOutputBuffer, getTerminalBufferText, getLastMeaningfulText } from './terminal-output-buffer'
```
Add `onRawTerminalData` to it.

- [ ] **Step 3: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/terminal-output-buffer.ts apps/desktop/src/main/index.ts
git commit -m "feat: hook terminal-title-tracker into raw pty data"
```

---

### Task 4: Create activity-classifier module

**Files:**
- Create: `apps/desktop/src/main/activity-classifier.ts`
- Create: `apps/desktop/src/main/activity-classifier.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// apps/desktop/src/main/activity-classifier.test.ts
import { describe, it, expect } from 'vitest'
import { classifyActivity } from './activity-classifier'

describe('activity-classifier', () => {
  it('detects interrupted state', () => {
    const buffer = 'some output\nInterrupted · What should Claude do instead?\n'
    expect(classifyActivity(buffer)).toBe('interrupted')
  })

  it('detects permission_request from yes/no dialog', () => {
    const buffer = 'Do you want to execute this command?\n  Yes  No\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('detects permission_request from allow/deny pattern', () => {
    const buffer = 'Allow this action?\n  Allow  Deny\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('detects thinking state from spinner verb', () => {
    const buffer = 'some previous output\n✻ Thinking\n'
    expect(classifyActivity(buffer)).toBe('thinking')
  })

  it('detects thinking with various spinner chars', () => {
    expect(classifyActivity('output\n✳ Pondering\n')).toBe('thinking')
    expect(classifyActivity('output\n✶ Contemplating\n')).toBe('thinking')
    expect(classifyActivity('output\n· Reasoning\n')).toBe('thinking')
  })

  it('detects tool_executing from tool name near spinner', () => {
    expect(classifyActivity('output\n✻ Read src/index.ts\n')).toBe('tool_executing')
    expect(classifyActivity('output\n✳ Bash npm test\n')).toBe('tool_executing')
    expect(classifyActivity('output\n· Edit file.ts\n')).toBe('tool_executing')
    expect(classifyActivity('output\n✶ Write new-file.ts\n')).toBe('tool_executing')
  })

  it('detects turn_complete from past-tense verb with duration', () => {
    expect(classifyActivity('output\nBaked for 5s\n')).toBe('turn_complete')
    expect(classifyActivity('output\nWorked for 2.3s\n')).toBe('turn_complete')
    expect(classifyActivity('output\nCrunched for 12s\n')).toBe('turn_complete')
  })

  it('returns null when no pattern matches', () => {
    expect(classifyActivity('just some random text output')).toBeNull()
  })

  it('returns null for empty buffer', () => {
    expect(classifyActivity('')).toBeNull()
  })

  it('prioritizes interrupted over other states', () => {
    const buffer = '✻ Thinking\nInterrupted · What should Claude do instead?\n'
    expect(classifyActivity(buffer)).toBe('interrupted')
  })

  it('prioritizes permission_request over thinking', () => {
    const buffer = '✻ Thinking\nAllow this action?\n  Yes  No\n'
    expect(classifyActivity(buffer)).toBe('permission_request')
  })

  it('only scans the tail of the buffer', () => {
    // "Interrupted" far back in buffer should not trigger — only tail matters
    const old = 'Interrupted\n'
    const padding = 'x\n'.repeat(200)
    const recent = '✻ Thinking\n'
    expect(classifyActivity(old + padding + recent)).toBe('thinking')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/activity-classifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/main/activity-classifier.ts
// Pure-function classifier that pattern-matches terminal buffer content
// to determine granular activity sub-state. Returns null if no pattern matches.

import type { ActivityState } from '../shared/types'

const SCAN_TAIL = 500 // only scan the last N chars of the buffer

const SPINNER_CHARS = '[✢✳✶✻✽*·⠂⠐]'

const THINKING_VERBS = [
  'Thinking', 'Pondering', 'Contemplating', 'Reasoning', 'Cogitating',
  'Synthesizing', 'Reflecting', 'Analyzing', 'Processing', 'Computing',
  'Considering', 'Evaluating', 'Formulating', 'Imagining', 'Brainstorming',
  'Architecting', 'Assembling', 'Brewing', 'Calculating', 'Crafting',
]

const TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Agent', 'Search', 'NotebookEdit',
  'TodoWrite', 'TodoRead',
]

// Past-tense verbs used by Claude Code for turn completion
const COMPLETION_VERBS = [
  'Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked',
  'Crunched', 'Saut[eé]ed', 'Worked', 'Crafted', 'Built',
  'Computed', 'Processed', 'Synthesized', 'Assembled',
]

const INTERRUPTED_RE = /Interrupted/
const PERMISSION_RE = /\b(Yes|Allow)\s+(No|Deny)\b/i
const THINKING_RE = new RegExp(`${SPINNER_CHARS}\\s*(${THINKING_VERBS.join('|')})`)
const TOOL_RE = new RegExp(`${SPINNER_CHARS}\\s*(${TOOL_NAMES.join('|')})\\b`)
const COMPLETION_RE = new RegExp(`(${COMPLETION_VERBS.join('|')})\\s+for\\s+\\d+(\\.\\d+)?s`)

export function classifyActivity(buffer: string): Exclude<ActivityState, 'idle' | 'working' | 'stalled'> | null {
  if (!buffer) return null

  const tail = buffer.length > SCAN_TAIL ? buffer.slice(-SCAN_TAIL) : buffer

  // Priority 1: Interrupted
  if (INTERRUPTED_RE.test(tail)) return 'interrupted'

  // Priority 2: Permission request
  if (PERMISSION_RE.test(tail)) return 'permission_request'

  // Priority 3: Thinking (check before tool_executing since both use spinner chars)
  if (THINKING_RE.test(tail)) return 'thinking'

  // Priority 4: Tool executing
  if (TOOL_RE.test(tail)) return 'tool_executing'

  // Priority 5: Turn complete
  if (COMPLETION_RE.test(tail)) return 'turn_complete'

  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/activity-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/activity-classifier.ts apps/desktop/src/main/activity-classifier.test.ts
git commit -m "feat: add activity-classifier module"
```

---

### Task 5: Integrate classifier into terminal-activity-detector

**Files:**
- Modify: `apps/desktop/src/main/terminal-activity-detector.ts`
- Modify: `apps/desktop/src/main/terminal-activity-detector.test.ts`

- [ ] **Step 1: Update the test file**

Replace the contents of `apps/desktop/src/main/terminal-activity-detector.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startTracking,
  stopTracking,
  initActivityDetector,
  stopActivityDetector,
  _getState,
  _tickAll,
} from './terminal-activity-detector'
import type { ActivityState } from '../shared/types'

describe('terminal-activity-detector', () => {
  let snapshotProvider: (sessionId: string) => string
  let titleAnimatingProvider: (sessionId: string) => boolean
  let emittedStates: { sessionId: string; state: ActivityState }[]

  beforeEach(() => {
    snapshotProvider = vi.fn(() => '')
    titleAnimatingProvider = vi.fn(() => false)
    emittedStates = []
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
  })

  afterEach(() => {
    stopActivityDetector()
  })

  it('starts in idle state', () => {
    startTracking('s1')
    expect(_getState('s1')).toBe('idle')
  })

  it('transitions to working when content changes', () => {
    let content = 'hello'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'hello world'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('transitions to idle after content stops changing for idle timeout', () => {
    vi.useFakeTimers()
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      idleTimeoutMs: 100,
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    vi.advanceTimersByTime(150)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'idle' },
    ])
    vi.useRealTimers()
  })

  it('detects thinking sub-state when title is animating', () => {
    let content = 'output\n✻ Thinking\n'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'output\n✻ Thinking harder\n'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'thinking' }])
  })

  it('detects tool_executing sub-state', () => {
    let content = 'output\n✻ Read src/main.ts\n'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'output\n✻ Read src/main.ts more\n'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'tool_executing' }])
  })

  it('falls back to working when title animating but no pattern match', () => {
    let content = 'some random output'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'some random output changed'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('detects stalled when title animating but content frozen', () => {
    vi.useFakeTimers()
    let content = 'frozen content'
    snapshotProvider = vi.fn(() => content)
    titleAnimatingProvider = vi.fn(() => true)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: titleAnimatingProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      stalledTimeoutMs: 200,
    })
    startTracking('s1')

    _tickAll() // initialize
    // Content changed once to trigger working
    content = 'frozen content changed'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    // Now content freezes but title still animating
    vi.advanceTimersByTime(250)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'stalled' },
    ])
    vi.useRealTimers()
  })

  it('does not emit duplicate states', () => {
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      isTitleAnimating: () => false,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll()
    content = 'c'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('cleans up on stopTracking', () => {
    startTracking('s1')
    stopTracking('s1')
    expect(_getState('s1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/terminal-activity-detector.test.ts`
Expected: FAIL — `isTitleAnimating` not in config

- [ ] **Step 3: Rewrite the implementation**

Replace the contents of `apps/desktop/src/main/terminal-activity-detector.ts` with:

```typescript
// Granular terminal activity detection.
// Uses OSC title animation as primary working/idle signal,
// with buffer pattern classification for sub-states.

import type { ActivityState } from '../shared/types'
import { classifyActivity } from './activity-classifier'

const POLL_INTERVAL_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 3_000
const DEFAULT_STALLED_TIMEOUT_MS = 10_000
const SNAPSHOT_SIZE = 1_000

interface SessionActivityState {
  lastSnapshot: string
  lastContentChangeAt: number
  currentState: ActivityState
  initialized: boolean
}

interface DetectorConfig {
  getSnapshot: (sessionId: string) => string
  isTitleAnimating: (sessionId: string) => boolean
  onStateChange: (sessionId: string, state: ActivityState) => void
  idleTimeoutMs?: number
  stalledTimeoutMs?: number
}

const sessions = new Map<string, SessionActivityState>()
let config: DetectorConfig | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function emitState(entry: SessionActivityState, sessionId: string, state: ActivityState): void {
  if (entry.currentState === state) return
  entry.currentState = state
  config!.onStateChange(sessionId, state)
}

function tickSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || !config) return

  const raw = config.getSnapshot(sessionId)
  const snapshot = raw.length > SNAPSHOT_SIZE ? raw.slice(-SNAPSHOT_SIZE) : raw
  const titleAnimating = config.isTitleAnimating(sessionId)
  const now = Date.now()

  if (!entry.initialized) {
    entry.lastSnapshot = snapshot
    entry.lastContentChangeAt = now
    entry.initialized = true
    return
  }

  const contentChanged = snapshot !== entry.lastSnapshot
  if (contentChanged) {
    entry.lastSnapshot = snapshot
    entry.lastContentChangeAt = now
  }

  const idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const stalledTimeout = config.stalledTimeoutMs ?? DEFAULT_STALLED_TIMEOUT_MS
  const timeSinceChange = now - entry.lastContentChangeAt

  // Idle: title not animating AND content unchanged for idle timeout
  if (!titleAnimating && !contentChanged && timeSinceChange > idleTimeout) {
    // Check for turn_complete or interrupted in the static buffer
    const subState = classifyActivity(snapshot)
    if (subState === 'turn_complete' || subState === 'interrupted') {
      emitState(entry, sessionId, subState)
    } else {
      emitState(entry, sessionId, 'idle')
    }
    return
  }

  // Stalled: title animating but content frozen for stalled timeout
  if (titleAnimating && !contentChanged && timeSinceChange > stalledTimeout) {
    emitState(entry, sessionId, 'stalled')
    return
  }

  // Active: title animating or content recently changed
  if (titleAnimating || contentChanged) {
    const subState = classifyActivity(snapshot)
    emitState(entry, sessionId, subState ?? 'working')
    return
  }

  // Content recently stopped changing but not yet past idle timeout — hold current state
}

export function _tickAll(): void {
  for (const sessionId of sessions.keys()) {
    tickSession(sessionId)
  }
}

export function _getState(sessionId: string): ActivityState | undefined {
  return sessions.get(sessionId)?.currentState
}

export function startTracking(sessionId: string): void {
  if (sessions.has(sessionId)) return
  sessions.set(sessionId, {
    lastSnapshot: '',
    lastContentChangeAt: Date.now(),
    currentState: 'idle',
    initialized: false,
  })
}

export function stopTracking(sessionId: string): void {
  sessions.delete(sessionId)
}

export function initActivityDetector(cfg: DetectorConfig): void {
  stopActivityDetector()
  config = cfg
  pollTimer = setInterval(_tickAll, POLL_INTERVAL_MS)
}

export function stopActivityDetector(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  sessions.clear()
  config = null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/terminal-activity-detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/terminal-activity-detector.ts apps/desktop/src/main/terminal-activity-detector.test.ts
git commit -m "feat: integrate classifier into terminal-activity-detector"
```

---

### Task 6: Wire isTitleAnimating into main process detector config

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add isTitleAnimating to detector config**

In `apps/desktop/src/main/index.ts`, the existing `feedTitleData` import is already added in Task 3. Now add `isTitleAnimating` to the import:

```typescript
import { feedRawData as feedTitleData, isTitleAnimating, clearSession as clearTitleSession } from './terminal-title-tracker'
```

Update the `initActivityDetector` call to include `isTitleAnimating`:

```typescript
initActivityDetector({
  getSnapshot: (sessionId) => getTerminalBufferText(sessionId),
  isTitleAnimating: (sessionId) => isTitleAnimating(sessionId),
  onStateChange: (sessionId, state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-work-state', sessionId, state)
    }
    if (state === 'idle' || state === 'turn_complete' || state === 'interrupted') {
      const persisted = loadPersistedData()
      const session = persisted.sessions[sessionId]
      const agentType = session?.processStatus === 'codex' ? 'codex' as const : 'claude' as const
      if (session?.processStatus === 'claude' || session?.processStatus === 'codex') {
        const lastText = getLastMeaningfulText(sessionId)
        void notifyIdleTransition(sessionId, agentType, lastText || undefined)
      }
    }
  },
})
```

Note: the idle notification now also fires on `turn_complete` and `interrupted` since those are effectively "agent stopped working" states.

- [ ] **Step 2: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat: wire isTitleAnimating into activity detector"
```

---

### Task 7: Update IPC, store, and preload for ActivityState

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/useAgentResponses.ts`

- [ ] **Step 1: Update preload type**

In `apps/desktop/src/preload/index.ts`, add the import for `ActivityState`:

```typescript
import type {
  ElectronAPI,
  CreateTerminalOpts,
  CreateTerminalResult,
  ProcessStatus,
  ActivityState,
  WriteSource,
  // ... rest of existing imports
} from '../shared/types'
```

Update the `onSessionWorkState` handler signature:

```typescript
onSessionWorkState: (callback: (sessionId: string, state: ActivityState) => void) => {
  const handler = (_event: any, sessionId: string, state: ActivityState) => callback(sessionId, state)
  ipcRenderer.on('session-work-state', handler)
  return () => { ipcRenderer.removeListener('session-work-state', handler) }
},
```

- [ ] **Step 2: Update store type**

In `apps/desktop/src/renderer/src/store/app-store.ts`, add `ActivityState` to the types import from `shared/types`:

```typescript
import type { ActivityState } from '../../../shared/types'
```

Change the `sessionWorkState` type in the `AppState` interface:

```typescript
// Before
sessionWorkState: Record<string, 'working' | 'idle'>
// After
sessionWorkState: Record<string, ActivityState>
```

Change the `setSessionWorkState` signature:

```typescript
// Before
setSessionWorkState: (sessionId: string, state: 'working' | 'idle') => void
// After
setSessionWorkState: (sessionId: string, state: ActivityState) => void
```

- [ ] **Step 3: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat: widen IPC and store types to ActivityState"
```

---

### Task 8: Update Sidebar and SessionItem to show status text

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/SessionItem.tsx`

- [ ] **Step 1: Add state-to-label mapping in Sidebar**

In `apps/desktop/src/renderer/src/components/Sidebar.tsx`, add a helper function near the top of the Sidebar component (after the store selectors):

```typescript
const getActivityLabel = (state: string | undefined): string | undefined => {
  switch (state) {
    case 'thinking': return 'Thinking'
    case 'tool_executing': return 'Executing tool'
    case 'working': return 'Working'
    case 'permission_request': return 'Permission needed'
    case 'interrupted': return 'Interrupted'
    case 'turn_complete': return 'Done'
    case 'stalled': return 'Stalled'
    default: return undefined
  }
}
```

- [ ] **Step 2: Update isSessionWorking to check all non-idle states**

Replace the existing `isSessionWorking` function:

```typescript
const isSessionWorking = (session: (typeof sessions)[string] | undefined) => {
  if (!session) return false
  const state = sessionWorkState[session.id]
  return state !== undefined && state !== 'idle' && state !== 'interrupted' && state !== 'turn_complete'
}
```

- [ ] **Step 3: Wire status labels into SessionItem rendering**

In the session rendering section (around line 1603), update the `statusLabel` assignment:

```typescript
const isWorking = isSessionWorking(session)
const agentResponse = getSessionAgentResponse(session)
const activityState = sessionWorkState[session.id]
const needsApproval = activityState === 'permission_request'
const needsUserInput = false
const statusLabel = getActivityLabel(activityState)
```

Do the same in the board/collapsed view section (around line 1782):

```typescript
const isWorking = isSessionWorking(session)
const activityState = sessionWorkState[session.id]
const needsApproval = activityState === 'permission_request'
const needsUserInput = false
const actionColor = needsApproval ? '#60a5fa' : null
```

- [ ] **Step 4: Update SessionItem for stalled animation**

In `apps/desktop/src/renderer/src/components/SessionItem.tsx`, update the icon animation logic to add a slow pulse for stalled state. Add a `activityState` prop:

Add to `SessionItemProps`:
```typescript
activityState?: string
```

Update the icon className logic:

```typescript
<span
  className={`relative shrink-0 ${
    showNeedsInputAnimation
      ? 'animate-session-attention'
      : activityState === 'stalled'
        ? 'animate-pulse'
        : isWorking && isAgent
          ? 'animate-spin'
          : 'opacity-60'
  }`}
>
```

In `Sidebar.tsx`, pass `activityState` to `SessionItem`:

```typescript
<SessionItem
  // ... existing props
  activityState={activityState}
/>
```

- [ ] **Step 5: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx apps/desktop/src/renderer/src/components/SessionItem.tsx
git commit -m "feat: show granular activity status in sidebar"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/desktop && npx vitest run
```

Expect: All new tests pass. Pre-existing failures unchanged.

- [ ] **Step 2: Run build**

```bash
cd apps/desktop && npx tsc --noEmit
```

- [ ] **Step 3: Smoke test**

Launch the app, open a Claude session, verify:
- Logo spins when Claude is working
- Status text shows "Thinking" during thinking phase
- Status text shows "Executing tool" during tool calls
- "Permission needed" shows with bounce animation when approval required
- "Done" shows briefly when turn completes
- Logo goes static + no status text when idle
- Plain terminal sessions still show working/idle correctly (content-change fallback)

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during verification"
```
