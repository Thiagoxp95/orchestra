# Terminal Content Change Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-layer activity detection system with a single terminal content change detector that works universally for all session types.

**Architecture:** A single `terminal-activity-detector.ts` module in main process polls terminal buffer snapshots every 500ms. If content changed, state is `working`. If unchanged for 3s, state transitions to `idle`. One IPC channel (`session-work-state`) replaces all previous work-state channels.

**Tech Stack:** Electron IPC, `terminal-output-buffer.ts` (existing buffer infrastructure), Zustand (renderer store)

---

### Task 1: Create terminal-activity-detector module

**Files:**
- Create: `apps/desktop/src/main/terminal-activity-detector.ts`
- Create: `apps/desktop/src/main/terminal-activity-detector.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// apps/desktop/src/main/terminal-activity-detector.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startTracking,
  stopTracking,
  initActivityDetector,
  stopActivityDetector,
  _getState,
  _tickAll,
} from './terminal-activity-detector'

describe('terminal-activity-detector', () => {
  let snapshotProvider: (sessionId: string) => string
  let emittedStates: { sessionId: string; state: 'working' | 'idle' }[]

  beforeEach(() => {
    snapshotProvider = vi.fn(() => '')
    emittedStates = []
    initActivityDetector({
      getSnapshot: snapshotProvider,
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
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    // First tick: stores snapshot, no state change (still idle, first snapshot)
    _tickAll()
    expect(emittedStates).toEqual([])

    // Change content and tick again
    content = 'hello world'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('transitions to idle after content stops changing for idle timeout', () => {
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
      idleTimeoutMs: 100,
    })
    startTracking('s1')

    // Trigger working
    _tickAll()
    content = 'b'
    _tickAll()
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])

    // Advance time past idle timeout without content change
    vi.advanceTimersByTime(150)
    _tickAll()
    expect(emittedStates).toEqual([
      { sessionId: 's1', state: 'working' },
      { sessionId: 's1', state: 'idle' },
    ])
  })

  it('does not emit duplicate states', () => {
    let content = 'a'
    snapshotProvider = vi.fn(() => content)
    initActivityDetector({
      getSnapshot: snapshotProvider,
      onStateChange: (sessionId, state) => {
        emittedStates.push({ sessionId, state })
      },
    })
    startTracking('s1')

    _tickAll()
    content = 'b'
    _tickAll() // working
    content = 'c'
    _tickAll() // still working, no duplicate emit
    expect(emittedStates).toEqual([{ sessionId: 's1', state: 'working' }])
  })

  it('cleans up on stopTracking', () => {
    startTracking('s1')
    stopTracking('s1')
    expect(_getState('s1')).toBeUndefined()
  })

  it('ignores ticks for untracked sessions', () => {
    _tickAll()
    expect(emittedStates).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/terminal-activity-detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/main/terminal-activity-detector.ts
// Universal terminal activity detection via content change polling.
// If terminal content keeps changing -> working. If static for IDLE_TIMEOUT_MS -> idle.

const POLL_INTERVAL_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 3_000
const SNAPSHOT_SIZE = 1_000

interface SessionActivityState {
  lastSnapshot: string
  lastChangeTime: number
  currentState: 'working' | 'idle'
  initialized: boolean
}

interface DetectorConfig {
  getSnapshot: (sessionId: string) => string
  onStateChange: (sessionId: string, state: 'working' | 'idle') => void
  idleTimeoutMs?: number
}

const sessions = new Map<string, SessionActivityState>()
let config: DetectorConfig | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function tickSession(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || !config) return

  const raw = config.getSnapshot(sessionId)
  const snapshot = raw.length > SNAPSHOT_SIZE ? raw.slice(-SNAPSHOT_SIZE) : raw

  if (!entry.initialized) {
    entry.lastSnapshot = snapshot
    entry.lastChangeTime = Date.now()
    entry.initialized = true
    return
  }

  if (snapshot !== entry.lastSnapshot) {
    entry.lastSnapshot = snapshot
    entry.lastChangeTime = Date.now()
    if (entry.currentState !== 'working') {
      entry.currentState = 'working'
      config.onStateChange(sessionId, 'working')
    }
  } else {
    const idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    if (
      entry.currentState === 'working' &&
      Date.now() - entry.lastChangeTime > idleTimeout
    ) {
      entry.currentState = 'idle'
      config.onStateChange(sessionId, 'idle')
    }
  }
}

export function _tickAll(): void {
  for (const sessionId of sessions.keys()) {
    tickSession(sessionId)
  }
}

export function _getState(sessionId: string): 'working' | 'idle' | undefined {
  return sessions.get(sessionId)?.currentState
}

export function startTracking(sessionId: string): void {
  if (sessions.has(sessionId)) return
  sessions.set(sessionId, {
    lastSnapshot: '',
    lastChangeTime: Date.now(),
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/terminal-activity-detector.test.ts`
Expected: PASS (the timer-based test needs `vi.useFakeTimers()` — adjust if needed)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/terminal-activity-detector.ts apps/desktop/src/main/terminal-activity-detector.test.ts
git commit -m "feat: add terminal-activity-detector module"
```

---

### Task 2: Wire detector into main process and add IPC channel

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add `onSessionWorkState` to `ElectronAPI` in types**

In `apps/desktop/src/shared/types.ts`, add to the `ElectronAPI` interface:

```typescript
onSessionWorkState: (callback: (sessionId: string, state: 'working' | 'idle') => void) => () => void
```

- [ ] **Step 2: Add IPC listener in preload**

In `apps/desktop/src/preload/index.ts`, add to the `api` object:

```typescript
onSessionWorkState: (callback: (sessionId: string, state: 'working' | 'idle') => void) => {
  const handler = (_event: any, sessionId: string, state: 'working' | 'idle') => callback(sessionId, state)
  ipcRenderer.on('session-work-state', handler)
  return () => { ipcRenderer.removeListener('session-work-state', handler) }
},
```

Also add `'session-work-state'` to `removeAllListeners`.

- [ ] **Step 3: Initialize detector in main process**

In `apps/desktop/src/main/index.ts`:

Add import at top:
```typescript
import { initActivityDetector, stopActivityDetector, startTracking, stopTracking } from './terminal-activity-detector'
```

In the `createWindow` function, after `initTerminalOutputBuffer(mainWindow)`, add:
```typescript
initActivityDetector({
  getSnapshot: (sessionId) => getTerminalBufferText(sessionId),
  onStateChange: (sessionId, state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-work-state', sessionId, state)
    }
  },
})
```

Add import for `getTerminalBufferText` from `./terminal-output-buffer`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "feat: wire terminal-activity-detector to IPC"
```

---

### Task 3: Add sessionWorkState to renderer store

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/useAgentResponses.ts`

- [ ] **Step 1: Add `sessionWorkState` to AppState**

In `apps/desktop/src/renderer/src/store/app-store.ts`:

Add to `AppState` interface:
```typescript
sessionWorkState: Record<string, 'working' | 'idle'>
setSessionWorkState: (sessionId: string, state: 'working' | 'idle') => void
```

Add to the store initial state:
```typescript
sessionWorkState: {},
```

Add the setter:
```typescript
setSessionWorkState: (sessionId, state) => {
  set((current) => {
    if (current.sessionWorkState[sessionId] === state) return current
    return { sessionWorkState: { ...current.sessionWorkState, [sessionId]: state } }
  })
},
```

- [ ] **Step 2: Wire IPC in useAgentResponses**

In `apps/desktop/src/renderer/src/hooks/useAgentResponses.ts`:

Add store selector:
```typescript
const setSessionWorkState = useAppStore((s) => s.setSessionWorkState)
```

Add IPC listener inside the useEffect:
```typescript
const cleanupSessionWorkState = window.electronAPI.onSessionWorkState((sessionId, state) => {
  setSessionWorkState(sessionId, state)
})
```

Add `cleanupSessionWorkState()` to the cleanup return.

Add `setSessionWorkState` to the dependency array.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts apps/desktop/src/renderer/src/hooks/useAgentResponses.ts
git commit -m "feat: add sessionWorkState to renderer store with IPC wiring"
```

---

### Task 4: Hook startTracking/stopTracking into session watchers

**Files:**
- Modify: `apps/desktop/src/main/claude-session-watcher.ts`
- Modify: `apps/desktop/src/main/codex-session-watcher.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add startTracking/stopTracking calls to claude-session-watcher**

In `apps/desktop/src/main/claude-session-watcher.ts`:

Add import:
```typescript
import { startTracking, stopTracking } from './terminal-activity-detector'
```

In `watchSession()`, after `sessions.set(sessionId, entry)`, add:
```typescript
startTracking(sessionId)
```

In `unwatchSession()`, before `sessions.delete(sessionId)`, add:
```typescript
stopTracking(sessionId)
```

- [ ] **Step 2: Add startTracking/stopTracking calls to codex-session-watcher**

In `apps/desktop/src/main/codex-session-watcher.ts`:

Add import:
```typescript
import { startTracking, stopTracking } from './terminal-activity-detector'
```

In `watchCodexSession()`, after `sessions.set(sessionId, entry)`, add:
```typescript
startTracking(sessionId)
```

In `unwatchCodexSession()`, before `sessions.delete(sessionId)`, add:
```typescript
stopTracking(sessionId)
```

- [ ] **Step 3: Also track plain terminal sessions**

In `apps/desktop/src/main/index.ts`, find the `ipcMain.on('terminal-create', ...)` handler (or wherever terminals are created). After terminal creation succeeds, call `startTracking(sessionId)`. On terminal exit, call `stopTracking(sessionId)`.

Find the `terminal-exit` emission path and add `stopTracking(sessionId)` there.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/claude-session-watcher.ts apps/desktop/src/main/codex-session-watcher.ts apps/desktop/src/main/index.ts
git commit -m "feat: hook startTracking/stopTracking into session lifecycle"
```

---

### Task 5: Switch Sidebar to use sessionWorkState

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add new state selector**

Add to Sidebar component's store selectors:
```typescript
const sessionWorkState = useAppStore((s) => s.sessionWorkState)
```

- [ ] **Step 2: Replace isSessionWorking and getSessionState**

Replace the `getSessionState` / `getLegacySessionState` / `isSessionWorking` logic with:

```typescript
const isSessionWorking = (session: (typeof sessions)[string] | undefined) => {
  if (!session) return false
  return sessionWorkState[session.id] === 'working'
}
```

Remove `getSessionState`, `getLegacySessionState`, `getCodexSessionState` helper functions.

Replace all `getSessionState(session) === 'working'` checks with `isSessionWorking(session)`.

Replace `getSessionState(session)` used for `needsApproval` / `needsUserInput` checks — since these states no longer exist, remove those prop passes from `SessionItem`. The `needsApproval` and `needsUserInput` props should always be `false`.

- [ ] **Step 3: Clean up removed state reads**

Remove these selectors from Sidebar:
```typescript
const claudeWorkState = useAppStore((s) => s.claudeWorkState)
const codexWorkState = useAppStore((s) => s.codexWorkState)
const sessionNeedsUserInput = useAppStore((s) => s.sessionNeedsUserInput)
const normalizedAgentState = useAppStore((s) => s.normalizedAgentState)
```

Remove the import of `AgentSessionState` from `agent-session-types`.

Update any debug overlay rendering that referenced the removed states — simplify to show `sessionWorkState[session.id]` instead.

- [ ] **Step 4: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "refactor: switch Sidebar to use sessionWorkState"
```

---

### Task 6: Remove old activity detection from session watchers

**Files:**
- Modify: `apps/desktop/src/main/claude-session-watcher.ts`
- Modify: `apps/desktop/src/main/codex-session-watcher.ts`

- [ ] **Step 1: Gut claude-session-watcher activity detection**

Strip `claude-session-watcher.ts` down to just session lifecycle management. Remove:
- All imports from `./claude-structured-activity`, `./agent-session-authority`, `./claude-hook-runtime`
- The `agentRegistry` variable and `setAgentSessionRegistryRef` function
- The `SessionEntry` fields: `jsonlPath`, `lastWorkState`, `lastResponse`, `lastUserPrompt`, `lastHookEvent`, `lastHookEventAt`, `pollInterval`
- All functions: `checkStructuredActivity`, `emitWorkState`, `scheduleIdleNotification`, `startPolling`, `stopPolling`, `applyPendingHookEvent`, `applyClaudeHookMetadata`, `applyClaudeHookEventToEntry`, `setLastResponse`, `clearLastResponse`, `ensureJsonlPath`, `assignJsonlPath`, `unassignJsonlPath`
- The `pendingHookEvents`, `jsonlAssignments`, `pendingIdleNotify` maps
- `applyClaudeHookEvent`, `hintInterrupt`, `markClaudeSessionStarted`, `getClaudeWatcherDebugState`
- IPC sends for `'claude-work-state'` and `'claude-last-response'`

Keep:
- `watchSession(sessionId, cwd)` — just tracks the session and calls `startTracking`
- `unwatchSession(sessionId)` — calls `stopTracking` and cleans up
- `initClaudeWatcher(window)` — stores mainWindow ref
- `stopAllWatchers()` — cleans up

The simplified file should be ~40 lines.

- [ ] **Step 2: Gut codex-session-watcher activity detection**

Same treatment. Strip down to:
- `watchCodexSession(sessionId, cwd)` → tracks session + `startTracking`
- `unwatchCodexSession(sessionId)` → `stopTracking` + cleanup
- `initCodexWatcher(window)` / `stopAllCodexWatchers()`

Remove all: structured activity polling, terminal fallback detection, hook event handling, idle notification scheduling, work state emission.

- [ ] **Step 3: Update main/index.ts imports**

Remove from `index.ts` imports:
- `getClaudeWatcherDebugState`, `markClaudeSessionStarted`, `hintInterrupt as hintClaudeInterrupt`, `setAgentSessionRegistryRef as setClaudeRegistryRef` from claude-session-watcher
- `getCodexWatcherDebugState`, `markCodexSessionStarted`, `setAgentSessionRegistryRef as setCodexRegistryRef` from codex-session-watcher
- `AgentSessionRegistry` from `./agent-session-authority`
- `getClaudeHookPort`, `startClaudeHookServer`, `stopClaudeHookServer` from `./claude-hook-server`

Remove from `index.ts` body:
- The `agentSessionRegistry` variable and its initialization block
- `setClaudeRegistryRef(agentSessionRegistry)` / `setCodexRegistryRef(agentSessionRegistry)`
- `codexAppServerManager` and its initialization
- `await startClaudeHookServer()` and `stopClaudeHookServer()` in cleanup
- IPC handlers for `'claude-session-started'`, `'claude-interrupt-hint'`
- IPC handlers for `'codex-session-started'`
- IPC handlers for `'get-claude-debug-state'`, `'get-codex-debug-state'`

Update the `agentIdleReaper` — it currently takes `NormalizedAgentSessionStatus` from the registry. Wire it to receive updates from the activity detector instead (or remove if not needed — check if it's opt-in only).

- [ ] **Step 4: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/claude-session-watcher.ts apps/desktop/src/main/codex-session-watcher.ts apps/desktop/src/main/index.ts
git commit -m "refactor: strip activity detection from session watchers"
```

---

### Task 7: Remove old state from renderer

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`
- Modify: `apps/desktop/src/renderer/src/hooks/useAgentResponses.ts`

- [ ] **Step 1: Remove old state slices from app-store**

Remove from `AppState` interface:
```
claudeWorkState, codexWorkState, sessionNeedsUserInput, normalizedAgentState
```

Remove corresponding initial values, setters (`setClaudeWorkState`, `setCodexWorkState`, `setSessionNeedsUserInput`, `clearSessionNeedsUserInput`, `setNormalizedAgentState`, `clearNormalizedAgentState`), and the `removeSessionNeedsUserInput` helper.

Remove from `loadPersistedState` any references to `claudeWorkState`, `codexWorkState`, `sessionNeedsUserInput`, `normalizedAgentState`.

Remove import of `NormalizedAgentSessionStatus` and types `ClaudeWorkState`, `CodexWorkState` if no longer used.

- [ ] **Step 2: Clean up useAgentResponses**

Remove all old IPC listeners:
- `onClaudeLastResponse`, `onClaudeWorkState`
- `onCodexLastResponse`, `onCodexWorkState`
- `onAgentSessionState`

Remove `applyNormalizedStateSideEffects` function.

Remove the corresponding store selectors that are no longer used.

Keep: `onTerminalLastOutput` (still used for terminal response previews), `onSessionWorkState` (new).

- [ ] **Step 3: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts apps/desktop/src/renderer/src/hooks/useAgentResponses.ts
git commit -m "refactor: remove old activity state from renderer"
```

---

### Task 8: Remove old IPC channels from preload

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Remove old IPC methods from preload**

Remove from `api` object in `preload/index.ts`:
- `claudeSessionStarted`
- `claudeInterruptHint`
- `onClaudeLastResponse`
- `onClaudeWorkState`
- `onCodexWorkState`
- `onAgentSessionState`
- `getClaudeDebugState`
- `getCodexDebugState`
- `codexSessionStarted`

Remove from `removeAllListeners`:
- `'claude-last-response'`
- `'claude-work-state'`
- `'codex-work-state'`
- `'agent-session-state'`

Keep: `onCodexLastResponse`, `onClaudeLastResponse` only if still emitted somewhere; otherwise remove too. Keep `onTerminalLastOutput`.

- [ ] **Step 2: Remove old types from shared/types.ts**

Remove from `ElectronAPI` interface:
- `claudeSessionStarted`, `claudeInterruptHint`
- `onClaudeLastResponse`, `onClaudeWorkState`
- `onCodexWorkState`, `onAgentSessionState`
- `getClaudeDebugState`, `getCodexDebugState`
- `codexSessionStarted`

Remove types `ClaudeWorkState` and `CodexWorkState` if no longer referenced.

Remove `ClaudeWatcherDebugState` and `CodexWatcherDebugState` interfaces.

Remove re-exports of `NormalizedAgentSessionStatus`, `isAgentSessionState`, `isAgentSessionAuthority`, `createDefaultNormalizedStatus` if no longer needed.

- [ ] **Step 3: Verify build**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "refactor: remove old IPC channels and types"
```

---

### Task 9: Delete old detection files

**Files:**
- Delete: `apps/desktop/src/main/claude-activity-parser.ts`
- Delete: `apps/desktop/src/main/claude-activity-parser.test.ts`
- Delete: `apps/desktop/src/main/claude-structured-activity.ts`
- Delete: `apps/desktop/src/main/claude-structured-activity.test.ts`
- Delete: `apps/desktop/src/main/claude-terminal-activity.ts`
- Delete: `apps/desktop/src/main/codex-structured-activity.ts`
- Delete: `apps/desktop/src/main/codex-structured-activity.test.ts`
- Delete: `apps/desktop/src/main/codex-terminal-activity.ts`
- Delete: `apps/desktop/src/main/agent-session-authority.ts`
- Delete: `apps/desktop/src/main/agent-session-authority.test.ts`
- Delete: `apps/desktop/src/main/claude-hook-runtime.ts`
- Delete: `apps/desktop/src/main/claude-hook-runtime.test.ts`
- Delete: `apps/desktop/src/main/claude-hook-server.ts`
- Delete: `apps/desktop/src/shared/agent-session-types.test.ts`

- [ ] **Step 1: Delete all old detection files**

```bash
cd apps/desktop
rm -f src/main/claude-activity-parser.ts src/main/claude-activity-parser.test.ts
rm -f src/main/claude-structured-activity.ts src/main/claude-structured-activity.test.ts
rm -f src/main/claude-terminal-activity.ts
rm -f src/main/codex-structured-activity.ts src/main/codex-structured-activity.test.ts
rm -f src/main/codex-terminal-activity.ts
rm -f src/main/agent-session-authority.ts src/main/agent-session-authority.test.ts
rm -f src/main/claude-hook-runtime.ts src/main/claude-hook-runtime.test.ts
rm -f src/main/claude-hook-server.ts
rm -f src/shared/agent-session-types.test.ts
```

- [ ] **Step 2: Simplify agent-session-types.ts**

Reduce `apps/desktop/src/shared/agent-session-types.ts` to only what's still needed (if anything — check remaining imports). If nothing else imports from it, delete it too.

- [ ] **Step 3: Clean up any remaining broken imports**

Run: `cd apps/desktop && npx tsc --noEmit`

Fix any remaining import errors — likely in:
- `codex-app-server-manager.ts` (uses `AgentSessionRegistry` — remove registry usage, keep thread mapping only)
- `agent-idle-reaper.ts` (uses `NormalizedAgentSessionStatus` — adapt to accept simple `'working' | 'idle'` state)
- `idle-notifier.ts` (may reference removed types)
- `useNormalizedAgentState.ts` hook (delete if it exists and is no longer used)
- `agent-debug-report.ts` utility (update or remove references)
- `sidebar-session-order.ts` / test (remove `NormalizedAgentSessionStatus` references)

- [ ] **Step 4: Verify build and tests**

Run: `cd apps/desktop && npx tsc --noEmit && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete old activity detection files and fix remaining imports"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/desktop && npx vitest run
```

- [ ] **Step 2: Run build**

```bash
cd apps/desktop && npm run build
```

- [ ] **Step 3: Smoke test**

Launch the app, open a Claude session, and verify:
- Sidebar logo spins when Claude is outputting text
- Shimmer appears on session label
- Both stop ~3s after output stops
- Plain terminal sessions also show working/idle correctly

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during verification"
```
