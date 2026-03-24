# Agent State Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle multi-source sidebar activity detection with an explicit, per-session authority model where each agent session has exactly one authoritative state producer.

**Architecture:** Introduce a `NormalizedAgentSessionStatus` record per session in the main process. Claude sessions use hook events as primary authority; Codex sessions use the `codex app-server` protocol. Existing watcher logic becomes session-scoped fallback. The renderer consumes only normalized state for all activity/approval/input display.

**Tech Stack:** Electron (main/renderer IPC), TypeScript, Vitest, zustand store

**Spec:** `docs/superpowers/specs/2026-03-23-agent-state-authority-design.md`

**Note:** The spec defines Phase 2 as Codex App-Server and Phase 3 as Claude Hooks. This plan reorders them — Claude hooks first (simpler, lower risk), then Codex app-server. Phase 4 (Cleanup — mismatch rate evaluation, dead heuristic removal) is deferred to a follow-up plan after the authority model proves stable in production.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/shared/agent-session-types.ts` | Normalized state types (`AgentSessionAuthority`, `AgentSessionState`, `NormalizedAgentSessionStatus`) |
| `apps/desktop/src/shared/agent-session-types.test.ts` | Type guard tests |
| `apps/desktop/src/main/agent-session-authority.ts` | Main-process state registry, authority selection, fallback/degraded transitions, state mapping helpers |
| `apps/desktop/src/main/agent-session-authority.test.ts` | Unit tests for registry, mapping, authority precedence |
| `apps/desktop/src/main/codex-app-server-manager.ts` | Wraps `codex-app-server.ts` client with thread/session mapping, notification normalization, lifecycle management |
| `apps/desktop/src/main/codex-app-server-manager.test.ts` | Unit tests for thread mapping and state normalization |
| `apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts` | Selector hook for normalized state per session |

### Modified Files

| File | Changes |
|------|---------|
| `apps/desktop/src/shared/types.ts` | Import and re-export from `agent-session-types.ts`, add `ElectronAPI.onAgentSessionState` |
| `apps/desktop/src/main/index.ts` | Initialize authority registry, wire IPC for normalized state, initialize app-server manager |
| `apps/desktop/src/main/claude-session-watcher.ts` | Feed normalized registry from hook events (authority) and watcher (fallback) |
| `apps/desktop/src/main/codex-session-watcher.ts` | Feed normalized registry from hook events; fallback role when app-server is active |
| `apps/desktop/src/main/claude-hook-server.ts` | Light integration: forward hook events to authority registry |
| `apps/desktop/src/preload/index.ts` | Add `onAgentSessionState` IPC bridge |
| `apps/desktop/src/renderer/src/store/app-store.ts` | Add `normalizedAgentState` record, derive legacy fields from it |
| `apps/desktop/src/renderer/src/components/Sidebar.tsx` | Migrate activity rendering to normalized state |
| `apps/desktop/src/renderer/src/components/MaestroPane.tsx` | Migrate to normalized state |
| `apps/desktop/src/renderer/src/utils/sidebar-session-order.ts` | Use normalized state for attention priority |

---

## Phase 1: Normalization Layer

### Task 1: Define Normalized State Types

**Files:**
- Create: `apps/desktop/src/shared/agent-session-types.ts`
- Create: `apps/desktop/src/shared/agent-session-types.test.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Write failing tests for type guards**

```ts
// apps/desktop/src/shared/agent-session-types.test.ts
import { describe, expect, it } from 'vitest'
import {
  isAgentSessionState,
  isAgentSessionAuthority,
  createDefaultNormalizedStatus,
} from './agent-session-types'

describe('isAgentSessionState', () => {
  it('accepts valid states', () => {
    for (const state of ['unknown', 'working', 'waitingApproval', 'waitingUserInput', 'idle', 'error']) {
      expect(isAgentSessionState(state)).toBe(true)
    }
  })

  it('rejects invalid values', () => {
    expect(isAgentSessionState('busy')).toBe(false)
    expect(isAgentSessionState(null)).toBe(false)
  })
})

describe('isAgentSessionAuthority', () => {
  it('accepts valid authorities', () => {
    for (const auth of ['codex-app-server', 'claude-hooks', 'codex-watcher-fallback', 'claude-watcher-fallback']) {
      expect(isAgentSessionAuthority(auth)).toBe(true)
    }
  })

  it('rejects invalid values', () => {
    expect(isAgentSessionAuthority('magic')).toBe(false)
  })
})

describe('createDefaultNormalizedStatus', () => {
  it('creates an unknown status for claude', () => {
    const status = createDefaultNormalizedStatus('sess-1', 'claude')
    expect(status.sessionId).toBe('sess-1')
    expect(status.agent).toBe('claude')
    expect(status.state).toBe('unknown')
    expect(status.authority).toBe('claude-hooks')
    expect(status.connected).toBe(true)
  })

  it('creates an unknown status for codex', () => {
    const status = createDefaultNormalizedStatus('sess-2', 'codex')
    expect(status.authority).toBe('codex-app-server')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/shared/agent-session-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the types module**

```ts
// apps/desktop/src/shared/agent-session-types.ts

export type AgentSessionAuthority =
  | 'codex-app-server'
  | 'claude-hooks'
  | 'codex-watcher-fallback'
  | 'claude-watcher-fallback'

export type AgentSessionState =
  | 'unknown'
  | 'working'
  | 'waitingApproval'
  | 'waitingUserInput'
  | 'idle'
  | 'error'

export interface NormalizedAgentSessionStatus {
  sessionId: string
  agent: 'claude' | 'codex'
  state: AgentSessionState
  authority: AgentSessionAuthority
  connected: boolean
  degradedReason?: string
  lastResponsePreview: string
  lastTransitionAt: number
  updatedAt: number
}

const VALID_STATES: ReadonlySet<string> = new Set([
  'unknown', 'working', 'waitingApproval', 'waitingUserInput', 'idle', 'error',
])

const VALID_AUTHORITIES: ReadonlySet<string> = new Set([
  'codex-app-server', 'claude-hooks', 'codex-watcher-fallback', 'claude-watcher-fallback',
])

export function isAgentSessionState(value: unknown): value is AgentSessionState {
  return typeof value === 'string' && VALID_STATES.has(value)
}

export function isAgentSessionAuthority(value: unknown): value is AgentSessionAuthority {
  return typeof value === 'string' && VALID_AUTHORITIES.has(value)
}

export function createDefaultNormalizedStatus(
  sessionId: string,
  agent: 'claude' | 'codex',
): NormalizedAgentSessionStatus {
  const now = Date.now()
  return {
    sessionId,
    agent,
    state: 'unknown',
    authority: agent === 'claude' ? 'claude-hooks' : 'codex-app-server',
    connected: true,
    lastResponsePreview: '',
    lastTransitionAt: now,
    updatedAt: now,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/shared/agent-session-types.test.ts`
Expected: PASS

- [ ] **Step 5: Re-export from shared/types.ts**

Add to the bottom of `apps/desktop/src/shared/types.ts`:

```ts
export type {
  AgentSessionAuthority,
  AgentSessionState,
  NormalizedAgentSessionStatus,
} from './agent-session-types'
export { isAgentSessionState, isAgentSessionAuthority, createDefaultNormalizedStatus } from './agent-session-types'
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/agent-session-types.ts apps/desktop/src/shared/agent-session-types.test.ts apps/desktop/src/shared/types.ts
git commit -m "feat: add normalized agent session state types"
```

---

### Task 2: Create Agent Session Authority Registry

**Files:**
- Create: `apps/desktop/src/main/agent-session-authority.ts`
- Create: `apps/desktop/src/main/agent-session-authority.test.ts`

- [ ] **Step 1: Write failing tests for the registry**

```ts
// apps/desktop/src/main/agent-session-authority.test.ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  AgentSessionRegistry,
  mapClaudeHookToState,
  mapCodexThreadStatusToState,
} from './agent-session-authority'

describe('mapClaudeHookToState', () => {
  it('maps Start to working', () => {
    expect(mapClaudeHookToState('Start')).toBe('working')
  })

  it('maps Stop to idle', () => {
    expect(mapClaudeHookToState('Stop')).toBe('idle')
  })

  it('maps PermissionRequest to waitingApproval', () => {
    expect(mapClaudeHookToState('PermissionRequest')).toBe('waitingApproval')
  })
})

describe('mapCodexThreadStatusToState', () => {
  it('maps idle to idle', () => {
    expect(mapCodexThreadStatusToState({ type: 'idle' })).toBe('idle')
  })

  it('maps active to working', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: [] })).toBe('working')
  })

  it('maps active with waitingOnApproval to waitingApproval', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waitingApproval')
  })

  it('maps active with waitingOnUserInput to waitingUserInput', () => {
    expect(mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingUserInput')
  })

  it('maps systemError to error', () => {
    expect(mapCodexThreadStatusToState({ type: 'systemError' })).toBe('error')
  })

  it('maps notLoaded to unknown', () => {
    expect(mapCodexThreadStatusToState({ type: 'notLoaded' })).toBe('unknown')
  })
})

describe('AgentSessionRegistry', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('registers a session and returns default status', () => {
    registry.register('s1', 'claude')
    const status = registry.get('s1')
    expect(status?.agent).toBe('claude')
    expect(status?.state).toBe('unknown')
    expect(status?.authority).toBe('claude-hooks')
  })

  it('transitions state and emits', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('working')
    expect(emitted.length).toBe(1)
    expect(emitted[0].status.state).toBe('working')
  })

  it('does not emit when state is unchanged', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    registry.transition('s1', 'working', 'claude-hooks')
    expect(emitted.length).toBe(1)
  })

  it('authoritative source wins over fallback', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')
    // Fallback tries to set idle — should be rejected because hooks are fresher
    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-hooks')
  })

  it('fallback can set state when authority is absent', () => {
    registry.register('s1', 'claude')
    // No authoritative transition yet — fallback can set state
    registry.transitionFallback('s1', 'working', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-watcher-fallback')
  })

  it('fallback takes over after authority goes stale', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')

    // Simulate time passing — make the last transition stale
    const status = registry.get('s1')!
    ;(status as any).lastTransitionAt = Date.now() - 120_000

    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('unregisters a session', () => {
    registry.register('s1', 'claude')
    registry.unregister('s1')
    expect(registry.get('s1')).toBeUndefined()
  })

  it('degrades a session', () => {
    registry.register('s1', 'codex')
    registry.degrade('s1', 'codex-watcher-fallback', 'app-server disconnected')
    const status = registry.get('s1')
    expect(status?.connected).toBe(false)
    expect(status?.degradedReason).toBe('app-server disconnected')
    expect(status?.authority).toBe('codex-watcher-fallback')
  })

  it('updates response preview without changing state', () => {
    registry.register('s1', 'claude')
    registry.updateResponsePreview('s1', 'Hello world')
    expect(registry.get('s1')?.lastResponsePreview).toBe('Hello world')
  })

  it('getAll returns all registered sessions', () => {
    registry.register('s1', 'claude')
    registry.register('s2', 'codex')
    expect(registry.getAll()).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/agent-session-authority.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the registry**

```ts
// apps/desktop/src/main/agent-session-authority.ts
import {
  createDefaultNormalizedStatus,
  type AgentSessionAuthority,
  type AgentSessionState,
  type NormalizedAgentSessionStatus,
} from '../shared/agent-session-types'
import type { ClaudeHookEventType } from './claude-hook-runtime'
import type { CodexThreadStatus } from './codex-thread-state'

/** How long before an authoritative transition is considered stale (ms). */
const AUTHORITY_STALE_MS = 60_000

export type StateChangeListener = (
  sessionId: string,
  status: NormalizedAgentSessionStatus,
) => void

// --- Mapping helpers ---

export function mapClaudeHookToState(eventType: ClaudeHookEventType): AgentSessionState {
  switch (eventType) {
    case 'Start': return 'working'
    case 'Stop': return 'idle'
    case 'PermissionRequest': return 'waitingApproval'
  }
}

export function mapCodexThreadStatusToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  if (!status) return 'unknown'

  switch (status.type) {
    case 'idle': return 'idle'
    case 'systemError': return 'error'
    case 'notLoaded': return 'unknown'
    case 'active': {
      const flags = status.activeFlags ?? []
      if (flags.includes('waitingOnUserInput')) return 'waitingUserInput'
      if (flags.includes('waitingOnApproval')) return 'waitingApproval'
      return 'working'
    }
  }
}

// --- Registry ---

export class AgentSessionRegistry {
  private sessions = new Map<string, NormalizedAgentSessionStatus>()
  private listener: StateChangeListener

  constructor(listener: StateChangeListener) {
    this.listener = listener
  }

  register(sessionId: string, agent: 'claude' | 'codex'): NormalizedAgentSessionStatus {
    const status = createDefaultNormalizedStatus(sessionId, agent)
    this.sessions.set(sessionId, status)
    return status
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get(sessionId: string): NormalizedAgentSessionStatus | undefined {
    return this.sessions.get(sessionId)
  }

  getAll(): NormalizedAgentSessionStatus[] {
    return [...this.sessions.values()]
  }

  /**
   * Authoritative state transition — from hooks or app-server.
   * Always applies and emits if the state changed.
   */
  transition(
    sessionId: string,
    state: AgentSessionState,
    authority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const changed = status.state !== state || status.authority !== authority
    const now = Date.now()

    status.state = state
    status.authority = authority
    status.connected = true
    status.degradedReason = undefined
    status.lastTransitionAt = now
    status.updatedAt = now

    if (changed) {
      this.listener(sessionId, { ...status })
    }
  }

  /**
   * Fallback state transition — from watcher heuristics.
   * Only applies when the authoritative source is absent or stale.
   */
  transitionFallback(
    sessionId: string,
    state: AgentSessionState,
    fallbackAuthority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const isFallbackAuthority =
      status.authority === 'claude-watcher-fallback' ||
      status.authority === 'codex-watcher-fallback'
    const isStale = (Date.now() - status.lastTransitionAt) > AUTHORITY_STALE_MS

    // Only allow fallback if current authority is already fallback, or the
    // authoritative source has gone stale, or state is still unknown
    if (!isFallbackAuthority && !isStale && status.state !== 'unknown') return

    const changed = status.state !== state || status.authority !== fallbackAuthority
    const now = Date.now()

    status.state = state
    status.authority = fallbackAuthority
    status.lastTransitionAt = now
    status.updatedAt = now

    if (changed) {
      this.listener(sessionId, { ...status })
    }
  }

  /**
   * Mark a session as degraded — switches authority to fallback.
   */
  degrade(
    sessionId: string,
    fallbackAuthority: AgentSessionAuthority,
    reason: string,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    status.authority = fallbackAuthority
    status.connected = false
    status.degradedReason = reason
    status.updatedAt = Date.now()
    this.listener(sessionId, { ...status })
  }

  /**
   * Update the response preview without changing state.
   */
  updateResponsePreview(sessionId: string, preview: string): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const trimmed = preview.slice(0, 200)
    if (status.lastResponsePreview === trimmed) return

    status.lastResponsePreview = trimmed
    status.updatedAt = Date.now()
    // Don't emit for preview-only changes — renderer polls or uses legacy channel
  }

  /**
   * Reset a session to unknown (e.g., on new agent run).
   */
  reset(sessionId: string): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    const now = Date.now()
    status.state = 'unknown'
    status.connected = true
    status.degradedReason = undefined
    status.lastResponsePreview = ''
    status.lastTransitionAt = now
    status.updatedAt = now
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/agent-session-authority.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent-session-authority.ts apps/desktop/src/main/agent-session-authority.test.ts
git commit -m "feat: add agent session authority registry with state mapping"
```

---

### Task 3: Wire IPC Channel for Normalized State

**Files:**
- Modify: `apps/desktop/src/shared/types.ts` (add to ElectronAPI)
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add IPC type to ElectronAPI**

In `apps/desktop/src/shared/types.ts`, add inside the `ElectronAPI` interface after `onCodexWorkState`:

```ts
  onAgentSessionState: (callback: (status: NormalizedAgentSessionStatus) => void) => () => void
```

Also add to `removeAllListeners`:
```ts
  // In the removeAllListeners implementation, add:
  ipcRenderer.removeAllListeners('agent-session-state')
```

- [ ] **Step 2: Add preload bridge**

In `apps/desktop/src/preload/index.ts`, add the IPC listener for `agent-session-state` following the same pattern as `onClaudeWorkState`/`onCodexWorkState`:

```ts
  onAgentSessionState: (callback) => {
    const handler = (_: any, status: any) => callback(status)
    ipcRenderer.on('agent-session-state', handler)
    return () => { ipcRenderer.removeListener('agent-session-state', handler) }
  },
```

And in `removeAllListeners`, add:
```ts
    ipcRenderer.removeAllListeners('agent-session-state')
```

- [ ] **Step 3: Initialize registry in main process**

In `apps/desktop/src/main/index.ts`:

Add import:
```ts
import { AgentSessionRegistry } from './agent-session-authority'
```

Create a module-level registry and emit function. Before the `createWindow` function, add:

```ts
let agentSessionRegistry: AgentSessionRegistry | null = null
```

Inside `createWindow`, after `initClaudeWatcher(mainWindow)` and `initCodexWatcher(mainWindow)`, add:

```ts
  agentSessionRegistry = new AgentSessionRegistry((sessionId, status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-session-state', status)
    }
  })
```

Export a getter for other modules to access:
```ts
export function getAgentSessionRegistry(): AgentSessionRegistry | null {
  return agentSessionRegistry
}
```

- [ ] **Step 4: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts
git commit -m "feat: wire IPC channel for normalized agent session state"
```

---

### Task 4: Add Normalized State to Renderer Store

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`

- [ ] **Step 1: Add normalized state field and setter to the store interface**

In the `AppState` interface, add after `sessionNeedsUserInput`:

```ts
  normalizedAgentState: Record<string, NormalizedAgentSessionStatus>
```

Add setter:
```ts
  setNormalizedAgentState: (status: NormalizedAgentSessionStatus) => void
```

- [ ] **Step 2: Add default value and implementation**

In the `create<AppState>` call, add default:
```ts
  normalizedAgentState: {},
```

Add setter implementation:
```ts
  setNormalizedAgentState: (status) => {
    set((state) => ({
      normalizedAgentState: { ...state.normalizedAgentState, [status.sessionId]: status }
    }))
  },
```

- [ ] **Step 3: Wire IPC listener in useAgentResponses hook**

The IPC listeners for agent state live in `apps/desktop/src/renderer/src/hooks/useAgentResponses.ts`. Add the normalized state listener there, alongside the existing `onClaudeWorkState` and `onCodexWorkState` listeners:

```ts
// In useAgentResponses.ts, inside the useEffect:
const setNormalizedAgentState = useAppStore((s) => s.setNormalizedAgentState)

// Add inside the useEffect, after cleanupCodexState:
const cleanupNormalizedState = window.electronAPI.onAgentSessionState((status) => {
  setNormalizedAgentState(status)
})

// Add to the cleanup return:
cleanupNormalizedState()
```

Also add `setNormalizedAgentState` to the useEffect dependency array.

**Migration note:** During the transition, `sessionNeedsUserInput` will continue to be set by the legacy `onCodexWorkState` listener (when `state === 'waitingUserInput'`). The normalized state channel may emit `waitingUserInput` slightly before or after the legacy channel. This is fine — the renderer should prefer `normalizedAgentState` when present and only fall back to the legacy fields. Once the migration is complete, `sessionNeedsUserInput` can be derived entirely from `normalizedAgentState` and the legacy setter removed.

- [ ] **Step 4: Add import for NormalizedAgentSessionStatus**

```ts
import type { NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'
```

- [ ] **Step 5: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat: add normalized agent state to renderer store"
```

---

### Task 5: Feed Registry from Existing Watchers (Adapter)

**Files:**
- Modify: `apps/desktop/src/main/claude-session-watcher.ts`
- Modify: `apps/desktop/src/main/codex-session-watcher.ts`

This task wires the existing watchers to additionally feed the normalized registry without changing their existing behavior. The watchers continue emitting their legacy IPC channels — the registry is an additive layer.

- [ ] **Step 1: Add registry integration to claude-session-watcher**

In `apps/desktop/src/main/claude-session-watcher.ts`:

Add import:
```ts
import { getAgentSessionRegistry } from './index'
```

Note: This creates a circular dependency risk. If it does, we'll use a setter pattern instead — `let registry: AgentSessionRegistry | null = null` + `export function setAgentSessionRegistry(r) { registry = r }`. The main index calls the setter after creating the registry.

In the `emitWorkState` function, after the line `mainWindow.webContents.send('claude-work-state', ...)`, add:

```ts
  // Feed normalized registry
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    const authority = options.source === 'hook' ? 'claude-hooks' : 'claude-watcher-fallback'
    if (options.source === 'hook') {
      registry.transition(entry.sessionId, nextState === 'idle' ? 'idle' : 'working', 'claude-hooks' as const)
    } else {
      registry.transitionFallback(entry.sessionId, nextState === 'idle' ? 'idle' : 'working', 'claude-watcher-fallback' as const)
    }
  }
```

In `watchSession`, after `sessions.set(sessionId, entry)`, add:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.register(sessionId, 'claude')
  }
```

In `unwatchSession`, before `sessions.delete(sessionId)`, add:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.unregister(sessionId)
  }
```

In `markClaudeSessionStarted`, add after resetting state:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.reset(sessionId)
    registry.transition(sessionId, 'working', 'claude-hooks')
  }
```

- [ ] **Step 2: Add registry integration to codex-session-watcher**

Apply the same pattern to `apps/desktop/src/main/codex-session-watcher.ts`:

In `emitWorkState`, after `mainWindow.webContents.send('codex-work-state', ...)`:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    const isHookDriven = entry.lastHookEventAt != null && (Date.now() - entry.lastHookEventAt) < 10_000
    const normalizedState = nextState === 'waitingApproval' ? 'waitingApproval'
      : nextState === 'waitingUserInput' ? 'waitingUserInput'
      : nextState === 'working' ? 'working'
      : 'idle'
    if (isHookDriven) {
      registry.transition(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    } else {
      registry.transitionFallback(entry.sessionId, normalizedState, 'codex-watcher-fallback')
    }
  }
```

In `watchCodexSession`, after `sessions.set(sessionId, entry)`:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.register(sessionId, 'codex')
  }
```

In `unwatchCodexSession`, before `sessions.delete(sessionId)`:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.unregister(sessionId)
  }
```

In `markCodexSessionStarted`, add:

```ts
  const registry = getAgentSessionRegistry?.()
  if (registry) {
    registry.reset(sessionId)
    registry.transition(sessionId, 'working', 'codex-watcher-fallback')
  }
```

- [ ] **Step 3: Handle circular dependency**

If `getAgentSessionRegistry` from `./index` creates a circular dependency, use the setter pattern instead. Add to both watchers:

```ts
import type { AgentSessionRegistry } from './agent-session-authority'
let agentRegistry: AgentSessionRegistry | null = null
export function setAgentSessionRegistryRef(r: AgentSessionRegistry | null): void {
  agentRegistry = r
}
```

Then reference `agentRegistry` instead of `getAgentSessionRegistry()`. The main index calls `setAgentSessionRegistryRef(registry)` after creation.

- [ ] **Step 4: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/claude-session-watcher.ts apps/desktop/src/main/codex-session-watcher.ts apps/desktop/src/main/index.ts
git commit -m "feat: wire existing watchers to feed normalized agent state registry"
```

---

### Task 6: Create Normalized State Selector Hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts`

- [ ] **Step 1: Create the hook**

```ts
// apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts
import { useCallback, useMemo } from 'react'
import { useAppStore } from '../store/app-store'
import type { AgentSessionState, NormalizedAgentSessionStatus } from '../../../shared/agent-session-types'

/**
 * Derives a stable AgentSessionState from legacy store fields.
 * Used as a migration bridge — when the normalized IPC channel hasn't
 * populated yet, we derive the state from the legacy fields to avoid
 * unstable object references on every render.
 */
function deriveLegacyState(
  processStatus: 'claude' | 'codex',
  claudeWorkState: string | undefined,
  codexWorkState: string | undefined,
  needsInput: boolean | undefined,
): AgentSessionState {
  if (processStatus === 'claude') {
    return claudeWorkState === 'working' ? 'working' : 'idle'
  }

  if (codexWorkState === 'waitingUserInput' || needsInput) return 'waitingUserInput'
  if (codexWorkState === 'waitingApproval') return 'waitingApproval'
  if (codexWorkState === 'working') return 'working'
  return 'idle'
}

/**
 * Returns the normalized agent session status for a given session.
 * Falls back to deriving from legacy store fields if normalized state
 * hasn't been populated yet (migration period).
 */
export function useNormalizedAgentState(
  sessionId: string,
  processStatus: 'terminal' | 'claude' | 'codex',
): NormalizedAgentSessionStatus | null {
  const normalized = useAppStore(
    useCallback((s) => s.normalizedAgentState[sessionId] ?? null, [sessionId])
  )

  // Derive a stable state string from legacy fields (for referential stability)
  const legacyState = useAppStore(
    useCallback((s) => {
      if (processStatus === 'terminal') return null
      return deriveLegacyState(
        processStatus,
        s.claudeWorkState[sessionId],
        s.codexWorkState[sessionId],
        s.sessionNeedsUserInput[sessionId],
      )
    }, [sessionId, processStatus])
  )

  // Memoize the fallback object so it only changes when legacyState changes
  const fallback = useMemo(() => {
    if (normalized || !legacyState || processStatus === 'terminal') return null
    return {
      sessionId,
      agent: processStatus as 'claude' | 'codex',
      state: legacyState,
      authority: (processStatus === 'claude' ? 'claude-watcher-fallback' : 'codex-watcher-fallback') as const,
      connected: true,
      lastResponsePreview: '',
      lastTransitionAt: 0,
      updatedAt: 0,
    } satisfies NormalizedAgentSessionStatus
  }, [normalized, legacyState, sessionId, processStatus])

  return normalized ?? fallback
}
```

- [ ] **Step 2: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useNormalizedAgentState.ts
git commit -m "feat: add useNormalizedAgentState selector hook with legacy fallback"
```

---

## Phase 2: Claude Hook Authority

### Task 7: Elevate Hook Events to Authoritative in Claude Watcher

**Files:**
- Modify: `apps/desktop/src/main/claude-session-watcher.ts`

The claude-session-watcher already tracks `lastWorkStateSource` and respects hook events. The key change is to make hook-derived state impossible to override by title/jsonl/terminal when it's fresh.

- [ ] **Step 1: Add authority precedence to emitWorkState**

In `apps/desktop/src/main/claude-session-watcher.ts`, modify the `emitWorkState` function. After the startup grace check, before `entry.lastWorkState = nextState`, add a hook-authority guard:

```ts
  // Hook authority takes precedence — title/jsonl/terminal cannot override a fresh hook state
  const hookFreshnessMs = 30_000 // 30 seconds
  const hookIsFresh =
    entry.lastHookEvent != null &&
    entry.lastHookEventAt != null &&
    (Date.now() - entry.lastHookEventAt) < hookFreshnessMs
  const isNonHookSource = options.source !== 'hook' && options.source !== 'initial'

  if (hookIsFresh && isNonHookSource) {
    // Non-hook sources cannot override a fresh hook-derived state
    return
  }
```

- [ ] **Step 2: Map PermissionRequest to waitingApproval in applyPendingHookEvent**

Currently, `applyPendingHookEvent` only handles `Start` and `Stop`, routing `PermissionRequest` to `Stop` (idle). Fix this:

In the `applyPendingHookEvent` function, change the logic to explicitly handle `PermissionRequest`:

```ts
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
    const registry = agentRegistry
    if (registry) {
      registry.transition(entry.sessionId, 'waitingApproval', 'claude-hooks')
    }
    emitUpdates(entry)
    emitWorkState(entry, 'idle', { allowDuringStartup: true, source: 'hook' })
    return
  }

  // Stop
  emitUpdates(entry)
  emitWorkState(entry, 'idle', { allowDuringStartup: true, source: 'hook' })
}
```

- [ ] **Step 3: Feed PermissionRequest into normalized registry from applyClaudeHookEvent**

In `applyClaudeHookEvent`, after setting `entry.lastHookEvent` and `entry.lastHookEventAt`, add normalized state transition:

```ts
  // Feed normalized registry with precise state
  if (agentRegistry) {
    agentRegistry.transition(sessionId, mapClaudeHookToState(eventType), 'claude-hooks')
  }
```

Add import at the top:
```ts
import { mapClaudeHookToState } from './agent-session-authority'
```

- [ ] **Step 4: Verify existing claude-session-watcher tests still pass**

Run: `cd apps/desktop && npx vitest run src/main/claude-session-watcher.test.ts`
Expected: PASS (or update tests for the new behavior)

- [ ] **Step 5: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/claude-session-watcher.ts
git commit -m "feat: elevate Claude hook events to authoritative state source"
```

---

### Task 8: Add Claude Hook Authority Tests

**Files:**
- Modify: `apps/desktop/src/main/agent-session-authority.test.ts`

- [ ] **Step 1: Add Claude hook authority integration tests**

Add to `apps/desktop/src/main/agent-session-authority.test.ts`:

```ts
describe('Claude hook authority integration', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('Start -> PermissionRequest -> Stop yields working -> waitingApproval -> idle', () => {
    registry.register('s1', 'claude')

    registry.transition('s1', mapClaudeHookToState('Start'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('working')

    registry.transition('s1', mapClaudeHookToState('PermissionRequest'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('waitingApproval')

    registry.transition('s1', mapClaudeHookToState('Stop'), 'claude-hooks')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('fresh hook events cannot be overridden by watcher fallback', () => {
    registry.register('s1', 'claude')
    registry.transition('s1', 'working', 'claude-hooks')

    // Watcher fallback tries to set idle — rejected
    registry.transitionFallback('s1', 'idle', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-hooks')
  })

  it('missing hooks allow fallback recovery', () => {
    registry.register('s1', 'claude')
    // No hook event ever sent — fallback can set state
    registry.transitionFallback('s1', 'working', 'claude-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('working')
    expect(registry.get('s1')?.authority).toBe('claude-watcher-fallback')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd apps/desktop && npx vitest run src/main/agent-session-authority.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent-session-authority.test.ts
git commit -m "test: add Claude hook authority integration tests"
```

---

## Phase 3: Codex App-Server Authority

### Task 9: Create CodexAppServerManager

**Files:**
- Create: `apps/desktop/src/main/codex-app-server-manager.ts`
- Create: `apps/desktop/src/main/codex-app-server-manager.test.ts`

The existing `codex-app-server.ts` provides a JSON-RPC client over stdio. The manager wraps it with:
- Thread/session mapping
- Notification normalization into the registry
- Lifecycle management

- [ ] **Step 1: Write failing tests for the manager**

```ts
// apps/desktop/src/main/codex-app-server-manager.test.ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  CodexAppServerManager,
  mapCodexNotificationToState,
} from './codex-app-server-manager'
import type { AgentSessionRegistry } from './agent-session-authority'

describe('mapCodexNotificationToState', () => {
  it('maps thread/status/changed with idle status', () => {
    expect(mapCodexNotificationToState({ type: 'idle' })).toBe('idle')
  })

  it('maps active with approval flag', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waitingApproval')
  })

  it('maps active with input flag', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waitingUserInput')
  })

  it('maps active without flags to working', () => {
    expect(mapCodexNotificationToState({ type: 'active', activeFlags: [] })).toBe('working')
  })
})

describe('CodexAppServerManager', () => {
  it('stores and retrieves thread-session mapping', () => {
    const mockRegistry = {
      register: vi.fn(),
      transition: vi.fn(),
      unregister: vi.fn(),
      degrade: vi.fn(),
      get: vi.fn(),
    } as unknown as AgentSessionRegistry

    const manager = new CodexAppServerManager(mockRegistry)
    manager.mapSession('sess-1', 'thread-abc')

    expect(manager.getThreadIdForSession('sess-1')).toBe('thread-abc')
    expect(manager.getSessionIdForThread('thread-abc')).toBe('sess-1')
  })

  it('cleans up mapping on unmap', () => {
    const mockRegistry = {
      register: vi.fn(),
      transition: vi.fn(),
      unregister: vi.fn(),
      degrade: vi.fn(),
      get: vi.fn(),
    } as unknown as AgentSessionRegistry

    const manager = new CodexAppServerManager(mockRegistry)
    manager.mapSession('sess-1', 'thread-abc')
    manager.unmapSession('sess-1')

    expect(manager.getThreadIdForSession('sess-1')).toBeUndefined()
    expect(manager.getSessionIdForThread('thread-abc')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/main/codex-app-server-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the manager**

```ts
// apps/desktop/src/main/codex-app-server-manager.ts
import { getCodexAppServer, stopCodexAppServer } from './codex-app-server'
import { mapCodexThreadStatusToState } from './agent-session-authority'
import type { AgentSessionRegistry } from './agent-session-authority'
import type { AgentSessionState } from '../shared/agent-session-types'
import type { CodexThreadStatus } from './codex-thread-state'
import { debugWorkState } from './work-state-debug'

export function mapCodexNotificationToState(
  status: CodexThreadStatus | null | undefined,
): AgentSessionState {
  return mapCodexThreadStatusToState(status)
}

export class CodexAppServerManager {
  private registry: AgentSessionRegistry
  private sessionToThread = new Map<string, string>()
  private threadToSession = new Map<string, string>()
  private notificationCleanup: (() => void) | null = null
  private started = false

  constructor(registry: AgentSessionRegistry) {
    this.registry = registry
  }

  mapSession(sessionId: string, threadId: string): void {
    this.sessionToThread.set(sessionId, threadId)
    this.threadToSession.set(threadId, sessionId)
  }

  unmapSession(sessionId: string): void {
    const threadId = this.sessionToThread.get(sessionId)
    if (threadId) {
      this.threadToSession.delete(threadId)
    }
    this.sessionToThread.delete(sessionId)
  }

  getThreadIdForSession(sessionId: string): string | undefined {
    return this.sessionToThread.get(sessionId)
  }

  getSessionIdForThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId)
  }

  /**
   * Start the app-server and listen for notifications.
   * Returns true if successfully started.
   */
  /**
   * Start the app-server and listen for notifications.
   * Forces initialization by sending a thread/list request — the underlying
   * CodexAppServerClient starts lazily on first request(), so we must call
   * request() here to actually spawn the process and begin receiving notifications.
   */
  async start(): Promise<boolean> {
    if (this.started) return true

    try {
      const client = getCodexAppServer()
      this.notificationCleanup = client.onNotification((notification) => {
        this.handleNotification(notification)
      })
      // Force the app-server process to start by sending a request.
      // onNotification() only registers a listener — the process won't
      // spawn until the first request() triggers ensureStarted().
      await client.request('thread/list', {})
      this.started = true
      debugWorkState('codex-app-server-manager-started', {})
      return true
    } catch (error) {
      debugWorkState('codex-app-server-manager-start-failed', {
        error: String(error),
      })
      return false
    }
  }

  /**
   * Create a thread for a new Orchestra Codex session.
   * Returns the threadId or null if creation failed.
   */
  async createThread(sessionId: string, cwd: string): Promise<string | null> {
    try {
      const client = getCodexAppServer()
      const result = await client.request<{ threadId: string }>('thread/start', {
        cwd,
      })

      if (result?.threadId) {
        this.mapSession(sessionId, result.threadId)
        debugWorkState('codex-app-server-thread-created', {
          sessionId,
          threadId: result.threadId,
          cwd,
        })
        return result.threadId
      }

      return null
    } catch (error) {
      debugWorkState('codex-app-server-thread-create-failed', {
        sessionId,
        cwd,
        error: String(error),
      })
      return null
    }
  }

  stop(): void {
    this.notificationCleanup?.()
    this.notificationCleanup = null
    this.sessionToThread.clear()
    this.threadToSession.clear()
    this.started = false
    stopCodexAppServer()
  }

  private handleNotification(notification: { method?: string; params?: unknown }): void {
    if (!notification.method) return

    const params = notification.params as Record<string, unknown> | undefined
    if (!params) return

    const threadId = params.threadId as string | undefined
    if (!threadId) return

    const sessionId = this.threadToSession.get(threadId)
    if (!sessionId) return

    // Primary state driver
    if (notification.method === 'thread/status/changed') {
      const status = params.status as CodexThreadStatus | undefined
      const state = mapCodexNotificationToState(status)

      debugWorkState('codex-app-server-state-change', {
        sessionId,
        threadId,
        status,
        state,
      })

      this.registry.transition(sessionId, state, 'codex-app-server')
    }

    // Response preview from item/completed (assistant messages)
    if (notification.method === 'item/completed') {
      const item = params.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agentMessage' && item.text) {
        const preview = item.text.trim().slice(0, 200)
        if (preview) {
          this.registry.updateResponsePreview(sessionId, preview)
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/codex-app-server-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/codex-app-server-manager.ts apps/desktop/src/main/codex-app-server-manager.test.ts
git commit -m "feat: add CodexAppServerManager with thread mapping and notification handling"
```

---

### Task 10: Initialize App-Server Manager in Main Process

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Initialize the manager after the registry**

In `apps/desktop/src/main/index.ts`, after creating `agentSessionRegistry`, add:

```ts
import { CodexAppServerManager } from './codex-app-server-manager'
```

And after the registry creation:

```ts
  const codexAppServerManager = new CodexAppServerManager(agentSessionRegistry)
  codexAppServerManager.start().catch((err) => {
    console.warn('[codex-app-server-manager] failed to start:', err)
  })
```

In the close handler, before `stopAllCodexWatchers()`, add:

```ts
  codexAppServerManager.stop()
```

- [ ] **Step 2: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat: initialize CodexAppServerManager in main process"
```

---

### Task 11: Add Codex App-Server Authority Tests

**Files:**
- Modify: `apps/desktop/src/main/agent-session-authority.test.ts`

- [ ] **Step 1: Add Codex authority tests**

```ts
describe('Codex app-server authority', () => {
  let registry: AgentSessionRegistry
  let emitted: Array<{ sessionId: string; status: any }>

  beforeEach(() => {
    emitted = []
    registry = new AgentSessionRegistry((sessionId, status) => {
      emitted.push({ sessionId, status })
    })
  })

  it('thread/status/changed drives working -> waitingApproval -> waitingUserInput -> idle', () => {
    registry.register('s1', 'codex')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: [] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('working')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('waitingApproval')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('waitingUserInput')

    registry.transition('s1', mapCodexThreadStatusToState({ type: 'idle' }), 'codex-app-server')
    expect(registry.get('s1')?.state).toBe('idle')
  })

  it('app-server disconnect degrades to watcher fallback', () => {
    registry.register('s1', 'codex')
    registry.transition('s1', 'working', 'codex-app-server')

    registry.degrade('s1', 'codex-watcher-fallback', 'app-server disconnected')

    const status = registry.get('s1')
    expect(status?.connected).toBe(false)
    expect(status?.degradedReason).toBe('app-server disconnected')
    expect(status?.authority).toBe('codex-watcher-fallback')
    // State should still be working — degrade doesn't reset state
    expect(status?.state).toBe('working')
  })

  it('after degrade, watcher fallback can update state', () => {
    registry.register('s1', 'codex')
    registry.transition('s1', 'working', 'codex-app-server')
    registry.degrade('s1', 'codex-watcher-fallback', 'disconnected')

    // Now in fallback mode — watcher can update
    registry.transitionFallback('s1', 'idle', 'codex-watcher-fallback')
    expect(registry.get('s1')?.state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd apps/desktop && npx vitest run src/main/agent-session-authority.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/agent-session-authority.test.ts
git commit -m "test: add Codex app-server authority integration tests"
```

---

## Phase 4: Renderer Migration

### Task 12: Migrate Sidebar to Normalized State

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/utils/sidebar-session-order.ts`

- [ ] **Step 1: Update sidebar-session-order to accept normalized state**

In `apps/desktop/src/renderer/src/utils/sidebar-session-order.ts`, update the interface:

```ts
import type { NormalizedAgentSessionStatus, TerminalSession } from '../../../shared/types'

interface SidebarSessionOrderOptions {
  getNormalizedState: (sessionId: string) => NormalizedAgentSessionStatus | null
}

function getSessionAttentionPriority(
  session: Pick<TerminalSession, 'id'>,
  { getNormalizedState }: SidebarSessionOrderOptions,
): number {
  const state = getNormalizedState(session.id)
  if (!state) return 2

  if (state.state === 'waitingUserInput') return 0
  if (state.state === 'waitingApproval') return 1
  return 2
}

export function sortSessionsForSidebar<T extends Pick<TerminalSession, 'id'>>(
  sessions: T[],
  options: SidebarSessionOrderOptions,
): T[] {
  return sessions
    .map((session, index) => ({
      session,
      index,
      priority: getSessionAttentionPriority(session, options),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ session }) => session)
}
```

- [ ] **Step 2: Update Sidebar to read from normalized state**

In `apps/desktop/src/renderer/src/components/Sidebar.tsx`:

Add to the store reads at the top of the SidebarContent component:
```ts
const normalizedAgentState = useAppStore((s) => s.normalizedAgentState)
```

Replace the helper functions to use normalized state:

```ts
  const getSessionNormalizedState = (sessionId: string) =>
    normalizedAgentState[sessionId] ?? null

  const isSessionWorking = (session: (typeof sessions)[string] | undefined) => {
    if (!session) return false
    const state = normalizedAgentState[session.id]
    if (state) return state.state === 'working'
    // Legacy fallback during migration
    if (session.processStatus === 'claude') return claudeWorkState[session.id] === 'working'
    if (session.processStatus === 'codex') return getCodexSessionState(session.id) === 'working'
    return false
  }
```

Update `sortSessionsByAttention` to use the new interface:
```ts
  const sortSessionsByAttention = <T extends (typeof sessions)[string]>(list: T[]) => (
    sortSessionsForSidebar(list, {
      getNormalizedState: getSessionNormalizedState,
    })
  )
```

Update session rendering to derive `needsApproval` and `needsUserInput` from normalized state:

```ts
  // In the session rendering loop:
  const normalizedState = normalizedAgentState[session.id]
  const needsApproval = normalizedState?.state === 'waitingApproval'
    ?? (codexState === 'waitingApproval')
  const needsUserInput = normalizedState?.state === 'waitingUserInput'
    ?? (codexState === 'waitingUserInput' || sessionNeedsUserInput[session.id] === true)
```

- [ ] **Step 3: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx apps/desktop/src/renderer/src/utils/sidebar-session-order.ts
git commit -m "feat: migrate sidebar to consume normalized agent state"
```

---

### Task 13: Migrate MaestroPane to Normalized State

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/MaestroPane.tsx`

- [ ] **Step 1: Update MaestroPane to use normalized state**

In `apps/desktop/src/renderer/src/components/MaestroPane.tsx`, replace the workState and needsInput selectors:

```ts
  const normalizedState = useAppStore(
    useCallback((s) => s.normalizedAgentState[session.id], [session.id])
  )

  // Legacy fallback
  const legacyWorkState = useAppStore(
    useCallback((s) => {
      if (session.processStatus === 'claude') return s.claudeWorkState[session.id]
      return s.codexWorkState[session.id]
    }, [session.id, session.processStatus])
  )
  const legacyNeedsInput = useAppStore((s) => s.sessionNeedsUserInput[session.id])

  const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
  const isWorking = normalizedState?.state === 'working' ?? legacyWorkState === 'working'
  const needsInput = normalizedState?.state === 'waitingUserInput'
    ?? (legacyNeedsInput || legacyWorkState === 'waitingUserInput')
  const needsApproval = normalizedState?.state === 'waitingApproval'
    ?? legacyWorkState === 'waitingApproval'
```

Update `statusText`:
```ts
  const statusText = needsInput
    ? 'Waiting for input'
    : needsApproval
      ? 'Waiting for approval'
      : isWorking
        ? 'Working...'
        : isAgent
          ? 'Idle'
          : ''
```

- [ ] **Step 2: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/MaestroPane.tsx
git commit -m "feat: migrate MaestroPane to consume normalized agent state"
```

---

## Phase 5: Debug Observability

### Task 14: Expand Debug Overlay with Normalized State

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add normalized state to debug overlay**

In the Sidebar's debug overlay section (where `CLAUDE DEBUG` and `CODEX DEBUG` are rendered), add a normalized state line:

```tsx
{/* Before the existing agent-specific debug, add: */}
{normalizedAgentState[session.id] && (
  <div className="opacity-80">
    normalized `state={normalizedAgentState[session.id].state}` `auth={normalizedAgentState[session.id].authority}` `connected={normalizedAgentState[session.id].connected ? 'yes' : 'no'}`{normalizedAgentState[session.id].degradedReason ? ` `degraded={normalizedAgentState[session.id].degradedReason}`` : ''}
  </div>
)}
```

- [ ] **Step 2: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat: add normalized state to sidebar debug overlay"
```

---

### Task 15: Add Mismatch Reporting in Dev Mode

**Files:**
- Modify: `apps/desktop/src/main/agent-session-authority.ts`

- [ ] **Step 1: Add shadow comparison logging**

Add a method to `AgentSessionRegistry` for dev-mode shadow comparison:

```ts
  /**
   * Report a shadow comparison between authoritative state and watcher fallback.
   * Logs mismatches for debugging. Only call in dev mode.
   */
  reportShadowComparison(
    sessionId: string,
    watcherState: AgentSessionState,
    watcherAuthority: AgentSessionAuthority,
  ): void {
    const status = this.sessions.get(sessionId)
    if (!status) return

    // Only report when authoritative source differs from watcher
    const isFallbackAuthority =
      status.authority === 'claude-watcher-fallback' ||
      status.authority === 'codex-watcher-fallback'
    if (isFallbackAuthority) return // Watcher IS the authority — no mismatch possible

    if (status.state !== watcherState) {
      debugWorkState('agent-state-mismatch', {
        sessionId,
        authoritativeState: status.state,
        authoritativeAuthority: status.authority,
        watcherState,
        watcherAuthority,
      })
    }
  }
```

Add import for `debugWorkState`:
```ts
import { debugWorkState } from './work-state-debug'
```

- [ ] **Step 2: Wire shadow comparison from watchers**

In `apps/desktop/src/main/codex-session-watcher.ts`, in the `emitWorkState` function, after feeding the registry, add:

```ts
  // Dev-mode shadow comparison
  if (process.env.NODE_ENV === 'development' && agentRegistry) {
    agentRegistry.reportShadowComparison(entry.sessionId, normalizedState, 'codex-watcher-fallback')
  }
```

- [ ] **Step 3: Verify the app builds**

Run: `cd apps/desktop && npx electron-vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/agent-session-authority.ts apps/desktop/src/main/codex-session-watcher.ts
git commit -m "feat: add dev-mode shadow comparison for agent state mismatch reporting"
```

---

### Task 16: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `cd apps/desktop && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `cd apps/desktop && npx electron-vite build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address test/build issues from agent state authority implementation"
```
