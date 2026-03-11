# Maestro Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-screen multi-pane view showing all active AI agents in the current workspace with live interactive terminals, workspace-colored borders, and workspace cycling.

**Architecture:** `MaestroMode` component renders alongside (not replacing) Sidebar+TerminalArea — existing content is hidden with `display:none` to preserve xterm instances. Each agent pane gets a fresh xterm instance via `useMaestroTerminal` hook that subscribes to live PTY data without calling `createTerminal`. A new `getSnapshot` daemon message provides initial terminal state. Store additions: `maestroMode`, `maestroFocusedSessionId`, `preMaestroActiveSessionId`.

**Tech Stack:** React 19, zustand, xterm.js, WebglAddon, FitAddon, Electron IPC, NDJSON daemon protocol

> **Note on line numbers:** Line numbers in this plan are approximate guides. Always locate insertion points using the textual anchors (e.g. "after the `setDeletingWorktree` action") rather than relying on exact line numbers, as they may shift due to prior edits.

---

## Chunk 1: Daemon Snapshot Protocol + IPC Bridge

### Task 1: Add `getSnapshot` to daemon protocol

**Files:**
- Modify: `apps/desktop/src/daemon/protocol.ts`

- [ ] **Step 1: Add `getSnapshot` to DaemonRequest type union**

In `apps/desktop/src/daemon/protocol.ts`, find the `DaemonRequest` interface's `type` field and extend the union:

```ts
type: 'hello' | 'createOrAttach' | 'prewarmShell' | 'write' | 'resize' | 'kill' | 'signal' | 'listSessions' | 'detach' | 'getPromptHistory' | 'getSnapshot'
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/daemon/protocol.ts
git commit -m "feat(daemon): add getSnapshot message type to protocol"
```

### Task 2: Handle `getSnapshot` in daemon server

**Files:**
- Modify: `apps/desktop/src/daemon/daemon.ts`

- [ ] **Step 1: Add `getSessionSnapshot` method to TerminalHost class**

In `apps/desktop/src/daemon/daemon.ts`, add method to `TerminalHost` class after the `listSessions` method:

```ts
  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAttachable) return null
    return session.getSnapshotAsync()
  }
```

Note: Uses `getSnapshotAsync()` (not sync `getSnapshot()`) for consistency with the `attach()` flow, which also uses the async variant.

- [ ] **Step 2: Add getSnapshot case to handleMessage switch**

In the `handleMessage` function, after the `getPromptHistory` case (before the closing `}` of the switch), add:

```ts
    case 'getSnapshot': {
      const snapshot = await host.getSessionSnapshot(msg.sessionId)
      if (msg.id != null) sendJson(socket, { id: msg.id, ok: true, snapshot })
      break
    }
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/daemon/daemon.ts
git commit -m "feat(daemon): handle getSnapshot requests in daemon server"
```

### Task 3: Add `getSnapshot` to DaemonClient

**Files:**
- Modify: `apps/desktop/src/main/daemon-client.ts`

- [ ] **Step 1: Add getSnapshot method to DaemonClient class**

In `apps/desktop/src/main/daemon-client.ts`, before the `detach` method, add:

```ts
  async getSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const resp = await this.request({ type: 'getSnapshot', sessionId })
    return resp.snapshot ?? null
  }
```

`SessionSnapshot` is already imported on line 7 — no additional import needed.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/daemon-client.ts
git commit -m "feat(daemon-client): add getSnapshot method"
```

### Task 4: Add `terminal-snapshot-request` IPC handler

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add IPC handler in main process**

In `apps/desktop/src/main/index.ts`, after the `terminal-kill` handler (`ipcMain.on('terminal-kill', ...)`), add:

```ts
ipcMain.handle('terminal-snapshot-request', async (_, sessionId: string) => {
  try {
    return await getDaemonClient().getSnapshot(sessionId)
  } catch {
    return null
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(ipc): add terminal-snapshot-request handler"
```

### Task 5: Expose `requestTerminalSnapshot` in preload + types

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add to preload API object**

In `apps/desktop/src/preload/index.ts`, before the `saveState` method, add:

```ts
  requestTerminalSnapshot: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-snapshot-request', sessionId)
  },
```

- [ ] **Step 2: Add to ElectronAPI interface**

In `apps/desktop/src/shared/types.ts`, in the `ElectronAPI` interface, before the `saveState` method, add:

```ts
  requestTerminalSnapshot: (sessionId: string) => Promise<{ rehydrateSequences?: string; snapshotAnsi?: string } | null>
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts
git commit -m "feat(preload): expose requestTerminalSnapshot IPC method"
```

---

## Chunk 2: Store State + Keybindings

### Task 6: Add Maestro state and actions to zustand store

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`

- [ ] **Step 1: Add state fields to AppState interface**

In the `AppState` interface, after `deletingWorktrees: Set<string>`, add:

```ts
  maestroMode: boolean
  maestroFocusedSessionId: string | null
  preMaestroActiveSessionId: string | null
```

- [ ] **Step 2: Add action signatures to AppState interface**

After `setDeletingWorktree`, add:

```ts
  toggleMaestroMode: () => void
  setMaestroFocusedSession: (sessionId: string | null) => void
  cycleMaestroFocus: (direction: 'next' | 'prev') => void
```

- [ ] **Step 3: Add initial state values**

In the `create` call, after `deletingWorktrees: new Set<string>()`, add:

```ts
  maestroMode: false,
  maestroFocusedSessionId: null,
  preMaestroActiveSessionId: null,
```

- [ ] **Step 4: Implement toggleMaestroMode action**

After the `setDeletingWorktree` action implementation, add:

```ts
  toggleMaestroMode: () => {
    set((state) => {
      if (state.maestroMode) {
        // Exiting: restore previous session
        return {
          maestroMode: false,
          maestroFocusedSessionId: null,
          activeSessionId: state.preMaestroActiveSessionId ?? state.activeSessionId,
          preMaestroActiveSessionId: null
        }
      }
      // Entering: save current session, find first agent to focus
      const workspace = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null
      let firstAgentId: string | null = null
      if (workspace) {
        for (const tree of workspace.trees) {
          for (const sid of tree.sessionIds) {
            const s = state.sessions[sid]
            if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
              firstAgentId = sid
              break
            }
          }
          if (firstAgentId) break
        }
      }
      return {
        maestroMode: true,
        preMaestroActiveSessionId: state.activeSessionId,
        maestroFocusedSessionId: firstAgentId
      }
    })
  },
```

- [ ] **Step 5: Implement setMaestroFocusedSession**

```ts
  setMaestroFocusedSession: (sessionId) => set({ maestroFocusedSessionId: sessionId }),
```

- [ ] **Step 6: Implement cycleMaestroFocus**

```ts
  cycleMaestroFocus: (direction) => {
    set((state) => {
      const workspace = state.activeWorkspaceId ? state.workspaces[state.activeWorkspaceId] : null
      if (!workspace) return state
      const agentIds: string[] = []
      for (const tree of workspace.trees) {
        for (const sid of tree.sessionIds) {
          const s = state.sessions[sid]
          if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
            agentIds.push(sid)
          }
        }
      }
      if (agentIds.length === 0) return state
      const currentIdx = state.maestroFocusedSessionId
        ? agentIds.indexOf(state.maestroFocusedSessionId)
        : -1
      let nextIdx: number
      if (currentIdx === -1) {
        nextIdx = 0
      } else if (direction === 'next') {
        nextIdx = (currentIdx + 1) % agentIds.length
      } else {
        nextIdx = (currentIdx - 1 + agentIds.length) % agentIds.length
      }
      return { maestroFocusedSessionId: agentIds[nextIdx] }
    })
  },
```

- [ ] **Step 7: Guard setActiveWorkspace for maestro mode**

Find the existing `setActiveWorkspace` action and replace it with:

```ts
  setActiveWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (state.maestroMode) {
        // In maestro mode: don't touch activeSessionId
        let firstAgentId: string | null = null
        if (workspace) {
          for (const tree of workspace.trees) {
            for (const sid of tree.sessionIds) {
              const s = state.sessions[sid]
              if (s && (s.processStatus === 'claude' || s.processStatus === 'codex')) {
                firstAgentId = sid
                break
              }
            }
            if (firstAgentId) break
          }
        }
        return {
          activeWorkspaceId: id,
          maestroFocusedSessionId: firstAgentId
        }
      }
      const tree = workspace ? activeTree(workspace) : null
      return {
        activeWorkspaceId: id,
        activeSessionId: tree?.sessionIds[0] ?? null
      }
    })
  },
```

Note: Uses the existing `activeTree()` helper function (defined at top of file) for the non-maestro branch to stay consistent with the codebase.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat(store): add maestro mode state, actions, and workspace guard"
```

### Task 7: Add `toggle-maestro` keybinding

**Files:**
- Modify: `apps/desktop/src/renderer/src/keybindings.ts`

- [ ] **Step 1: Add toggle-maestro to BUILTIN_SHORTCUTS**

In `apps/desktop/src/renderer/src/keybindings.ts`, after the `vim-session-down` entry (last item in the array), add:

```ts
  { id: 'toggle-maestro', label: 'Toggle Maestro Mode', category: 'General', defaultKeybinding: 'Cmd+Shift+M', global: true },
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/keybindings.ts
git commit -m "feat(keybindings): add toggle-maestro shortcut (Cmd+Shift+M)"
```

---

## Chunk 3: useMaestroTerminal Hook

### Task 8: Create `useMaestroTerminal` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useMaestroTerminal.ts`

- [ ] **Step 1: Create the hook file**

Create `apps/desktop/src/renderer/src/hooks/useMaestroTerminal.ts`:

```ts
import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useAppStore } from '../store/app-store'

const api = window.electronAPI

export function useMaestroTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  termBg?: string,
  fontSize?: number
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize ?? 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg || '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(containerRef.current)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available, fall back to canvas renderer
    }

    fitAddon.fit()

    // Send user input to PTY — only when this pane is focused
    term.onData((data) => {
      const { maestroFocusedSessionId } = useAppStore.getState()
      if (maestroFocusedSessionId !== sessionId) return
      api.writeTerminal(sessionId, data)
      if (data.includes('\r') || data.includes('\n')) {
        const { sessionNeedsUserInput, clearSessionNeedsUserInput } = useAppStore.getState()
        if (sessionNeedsUserInput[sessionId]) {
          clearSessionNeedsUserInput(sessionId)
        }
      }
    })

    // Request initial snapshot first, THEN register live data listener.
    // This avoids a race condition where live output could be written twice
    // (once by the listener, once when the snapshot arrives).
    let removeDataListener: (() => void) | null = null

    api.requestTerminalSnapshot(sessionId).then((snapshot: any) => {
      if (snapshot) {
        if (snapshot.rehydrateSequences) {
          term.write(snapshot.rehydrateSequences)
        }
        if (snapshot.snapshotAnsi) {
          term.write(snapshot.snapshotAnsi)
        }
      }

      // Now register the live data listener — any output from this point
      // forward is new and won't overlap with the snapshot.
      removeDataListener = api.onTerminalData((sid: string, data: string) => {
        if (sid === sessionId) {
          term.write(data)
        }
      })
    })

    // Resize locally only — do NOT call api.resizeTerminal
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      removeDataListener?.()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // Update xterm background when workspace color changes
  useEffect(() => {
    if (termRef.current && termBg) {
      termRef.current.options.theme = {
        ...termRef.current.options.theme,
        background: termBg
      }
    }
  }, [termBg])

  // Update font size when grid layout changes
  useEffect(() => {
    if (termRef.current && fontSize) {
      termRef.current.options.fontSize = fontSize
      fitAddonRef.current?.fit()
    }
  }, [fontSize])

  return termRef
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useMaestroTerminal.ts
git commit -m "feat: add useMaestroTerminal hook for read-only-by-default xterm"
```

---

## Chunk 4: MaestroPane + MaestroMode Components

### Task 9: Create `MaestroPane` component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/MaestroPane.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/desktop/src/renderer/src/components/MaestroPane.tsx`:

```tsx
import { useRef, useEffect, useCallback } from 'react'
import { useMaestroTerminal } from '../hooks/useMaestroTerminal'
import { useAppStore } from '../store/app-store'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

interface MaestroPaneProps {
  session: TerminalSession
  termBg: string
  wsColor: string
  isFocused: boolean
  fontSize: number
  onFocus: () => void
}

export function MaestroPane({ session, termBg, wsColor, isFocused, fontSize, onFocus }: MaestroPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useMaestroTerminal(session.id, containerRef, termBg, fontSize)

  const workState = useAppStore(
    useCallback((s) => {
      if (session.processStatus === 'claude') return s.claudeWorkState[session.id]
      return s.codexWorkState[session.id]
    }, [session.id, session.processStatus])
  )
  const needsInput = useAppStore((s) => s.sessionNeedsUserInput[session.id])

  const isAgent = session.processStatus === 'claude' || session.processStatus === 'codex'
  const isWorking = workState === 'working'
  const badgeTxtColor = textColor(wsColor)

  useEffect(() => {
    if (isFocused && termRef.current) {
      termRef.current.focus()
    }
  }, [isFocused])

  const borderColor = isFocused
    ? wsColor
    : `${wsColor}88`

  const borderWidth = isFocused ? 3 : 2

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-lg"
      style={{
        border: `${borderWidth}px solid ${borderColor}`,
        backgroundColor: termBg
      }}
      onClick={onFocus}
    >
      {/* Pane badge */}
      <div
        className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium"
        style={{
          backgroundColor: `${wsColor}bb`,
          color: badgeTxtColor
        }}
      >
        {/* Agent type indicator */}
        <span className="opacity-80">{session.processStatus === 'claude' ? 'C' : 'X'}</span>
        <span className="truncate max-w-[120px]">{session.label}</span>
        {/* Work state indicator */}
        {needsInput && (
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" title="Needs input" />
        )}
        {isWorking && !needsInput && (
          <svg width="10" height="10" viewBox="0 0 10 10" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M5 1a4 4 0 0 1 4 4" />
          </svg>
        )}
        {!isWorking && !needsInput && isAgent && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 5 4.5 7.5 8 3" />
          </svg>
        )}
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="flex-1 w-full" />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/MaestroPane.tsx
git commit -m "feat: add MaestroPane component with badge and focus handling"
```

### Task 10: Create `MaestroMode` component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/MaestroMode.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/desktop/src/renderer/src/components/MaestroMode.tsx`:

```tsx
import { useMemo, useEffect, useCallback } from 'react'
import { useAppStore } from '../store/app-store'
import { MaestroPane } from './MaestroPane'
import { darkenColor } from './TerminalArea'
import { matchesKeybinding, getBinding } from '../keybindings'
import { textColor } from '../utils/color'
import type { TerminalSession } from '../../../shared/types'

function getGridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 2) return 2
  if (count === 3) return 3
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

function getFontSize(count: number): number {
  if (count <= 4) return 14
  return 12
}

export function MaestroMode() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const maestroFocusedSessionId = useAppStore((s) => s.maestroFocusedSessionId)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
  const setMaestroFocusedSession = useAppStore((s) => s.setMaestroFocusedSession)
  const cycleMaestroFocus = useAppStore((s) => s.cycleMaestroFocus)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const runAction = useAppStore((s) => s.runAction)
  const settings = useAppStore((s) => s.settings)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const wsColor = workspace?.color ?? '#2a2a3e'
  const termBg = workspace ? darkenColor(workspace.color) : '#1a1a2e'
  const txtColor = textColor(wsColor)

  // Derive agent sessions
  const agentSessions = useMemo(() => {
    if (!workspace) return []
    const allSessionIds = workspace.trees.flatMap(tree => tree.sessionIds)
    return allSessionIds
      .map(id => sessions[id])
      .filter((s): s is TerminalSession => Boolean(s) && (s.processStatus === 'claude' || s.processStatus === 'codex'))
  }, [workspace, sessions])

  // Auto-fix focused session if current one is gone
  useEffect(() => {
    if (agentSessions.length === 0) {
      if (maestroFocusedSessionId) setMaestroFocusedSession(null)
      return
    }
    if (!maestroFocusedSessionId || !agentSessions.find(s => s.id === maestroFocusedSessionId)) {
      setMaestroFocusedSession(agentSessions[0].id)
    }
  }, [agentSessions, maestroFocusedSessionId])

  // Sorted workspaces for cycling
  const sortedWorkspaces = useMemo(() => {
    return Object.values(workspaces).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }, [workspaces])

  const customActions = workspace?.customActions ?? []

  // Keydown handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const bind = (id: string) => getBinding(id, settings.keybindingOverrides)

    // Escape: exit maestro mode (only if no dialogs open)
    if (e.key === 'Escape') {
      const hasDialog = document.querySelector('[role="dialog"]') || document.querySelector('.fixed.inset-0')
      if (!hasDialog) {
        e.preventDefault()
        toggleMaestroMode()
        return
      }
    }

    // Focus cycling: Cmd+Up/Down, Ctrl+J/K
    if (matchesKeybinding(e, bind('cycle-sessions-up')) || matchesKeybinding(e, bind('vim-session-up'))) {
      e.preventDefault()
      cycleMaestroFocus('prev')
      return
    }
    if (matchesKeybinding(e, bind('cycle-sessions-down')) || matchesKeybinding(e, bind('vim-session-down'))) {
      e.preventDefault()
      cycleMaestroFocus('next')
      return
    }

    // Workspace cycling: Cmd+Left/Right
    if (matchesKeybinding(e, bind('cycle-workspaces-left')) || matchesKeybinding(e, bind('cycle-workspaces-right'))) {
      if (sortedWorkspaces.length > 1) {
        const currentIdx = sortedWorkspaces.findIndex(ws => ws.id === activeWorkspaceId)
        if (currentIdx !== -1) {
          const goLeft = matchesKeybinding(e, bind('cycle-workspaces-left'))
          const nextIdx = goLeft
            ? (currentIdx - 1 + sortedWorkspaces.length) % sortedWorkspaces.length
            : (currentIdx + 1) % sortedWorkspaces.length
          e.preventDefault()
          setActiveWorkspace(sortedWorkspaces[nextIdx].id)
          return
        }
      }
    }

    // Direct workspace switch: Cmd+Shift+1..9
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1
      if (idx < sortedWorkspaces.length) {
        e.preventDefault()
        setActiveWorkspace(sortedWorkspaces[idx].id)
        return
      }
    }

    // Custom action keybindings (e.g. Cmd+N for Claude, Cmd+O for Codex)
    // Note: runInBackground CLI actions are skipped — they need the Sidebar's
    // handleRunAction wrapper which is unavailable here. Agent actions (claude/codex)
    // always create sessions regardless of runInBackground, so they work fine.
    for (const action of customActions) {
      if (!action.keybinding) continue
      if (matchesKeybinding(e, action.keybinding)) {
        e.preventDefault()
        if (action.runInBackground && action.actionType !== 'claude' && action.actionType !== 'codex') {
          return // Background CLI actions not supported from Maestro Mode
        }
        if (activeWorkspaceId) runAction(activeWorkspaceId, action)
        return
      }
    }
  }, [
    settings.keybindingOverrides, toggleMaestroMode, cycleMaestroFocus,
    sortedWorkspaces, activeWorkspaceId, setActiveWorkspace,
    customActions, runAction
  ])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleKeyDown])

  const cols = getGridColumns(agentSessions.length)
  const fontSize = getFontSize(agentSessions.length)

  // Empty state
  if (agentSessions.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-xl" style={{ backgroundColor: termBg }}>
        <div className="w-full h-3 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-lg" style={{ color: `${txtColor}66` }}>No active agents</p>
          <p className="text-xs" style={{ color: `${txtColor}44` }}>Press Esc to exit Maestro Mode</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col rounded-xl overflow-hidden" style={{ backgroundColor: termBg }}>
      <div
        className="h-3 w-full shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <div
        className="flex-1 grid p-1 gap-[2px]"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridAutoRows: '1fr'
        }}
      >
        {agentSessions.map(session => (
          <MaestroPane
            key={session.id}
            session={session}
            termBg={termBg}
            wsColor={wsColor}
            isFocused={session.id === maestroFocusedSessionId}
            fontSize={fontSize}
            onFocus={() => setMaestroFocusedSession(session.id)}
          />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Export `darkenColor` from TerminalArea**

In `apps/desktop/src/renderer/src/components/TerminalArea.tsx`, `darkenColor` is already exported (line 35). No change needed — verify.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/MaestroMode.tsx
git commit -m "feat: add MaestroMode component with auto-grid and keybindings"
```

---

## Chunk 5: App Integration + NavBar Badge

### Task 11: Integrate MaestroMode into App.tsx

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports**

In `apps/desktop/src/renderer/src/App.tsx`, add imports after the existing imports:

```ts
import { MaestroMode } from './components/MaestroMode'
import { matchesKeybinding, getBinding } from './keybindings'
```

- [ ] **Step 2: Subscribe to maestro state**

After `const showDiffPanel = useAppStore(...)`, add:

```ts
  const maestroMode = useAppStore((s) => s.maestroMode)
  const toggleMaestroMode = useAppStore((s) => s.toggleMaestroMode)
```

- [ ] **Step 3: Add toggle-maestro keybinding handler**

Add a keybinding effect after the prewarm effect:

```ts
  // Global maestro toggle — must live at App level since Sidebar handler is guarded
  useEffect(() => {
    const handleMaestroToggle = (e: KeyboardEvent) => {
      const binding = getBinding('toggle-maestro', useAppStore.getState().settings.keybindingOverrides)
      if (binding && matchesKeybinding(e, binding)) {
        e.preventDefault()
        toggleMaestroMode()
      }
    }
    window.addEventListener('keydown', handleMaestroToggle, true)
    return () => window.removeEventListener('keydown', handleMaestroToggle, true)
  }, [toggleMaestroMode])
```

- [ ] **Step 4: Modify render to hide content when Maestro Mode is active**

**IMPORTANT:** Do NOT unmount Sidebar/TerminalArea — hide them with `display:none` to preserve xterm instances. Replace the inner content area from:

```tsx
        <div className={`flex flex-1 overflow-hidden ${isDev ? '' : 'pt-3'}`}>
          <Sidebar />
          {diffSelectedFile ? (
            <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
          ) : (
            <TerminalArea />
          )}
          {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
        </div>
```

To:

```tsx
        <div className={`flex flex-1 overflow-hidden ${isDev ? '' : 'pt-3'}`}>
          <div className="contents" style={maestroMode ? { display: 'none' } : undefined}>
            <Sidebar />
            {diffSelectedFile ? (
              <DiffView file={diffSelectedFile} onClose={() => setDiffSelectedFile(null)} />
            ) : (
              <TerminalArea />
            )}
            {showDiffPanel && <DiffPanel onClose={toggleDiffPanel} />}
          </div>
          {maestroMode && <MaestroMode />}
        </div>
```

Note: `className="contents"` makes the wrapper invisible to CSS layout when maestro is off. When maestro is on, `display:none` hides everything but keeps xterm instances mounted.

- [ ] **Step 5: Guard Sidebar's keydown handler for maestro mode**

Since Sidebar stays mounted (hidden), its keydown handler would still fire and conflict with MaestroMode's handler. In `apps/desktop/src/renderer/src/components/Sidebar.tsx`, find the main keybinding `useEffect` (the one that adds a `keydown` handler on `window`), and add an early return at the top of the handler function:

```ts
      // Skip when Maestro Mode is active — MaestroMode has its own handler
      const { maestroMode } = useAppStore.getState()
      if (maestroMode) return
```

This goes at the very beginning of the `handler` function inside the keybinding `useEffect`, before any keybinding checks.

- [ ] **Step 6: Guard Cmd+W for maestro mode**

In `App.tsx`, find the `onCloseActiveSession` handler and replace:

```ts
    const unsubClose = window.electronAPI.onCloseActiveSession(() => {
      const { activeSessionId } = useAppStore.getState()
      if (activeSessionId) {
        window.electronAPI.killTerminal(activeSessionId)
        useAppStore.getState().deleteSession(activeSessionId)
      }
    })
```

With:

```ts
    const unsubClose = window.electronAPI.onCloseActiveSession(() => {
      const state = useAppStore.getState()
      const targetSessionId = state.maestroMode
        ? state.maestroFocusedSessionId
        : state.activeSessionId
      if (targetSessionId) {
        window.electronAPI.killTerminal(targetSessionId)
        state.deleteSession(targetSessionId)
      }
    })
```

- [ ] **Step 7: Exclude maestro state from persistence — verify only**

The save-state effect serializes fields manually (`workspaces`, `sessions`, `activeWorkspaceId`, `activeSessionId`, `settings`, `claudeLastResponse`, `codexLastResponse`). The maestro fields (`maestroMode`, `maestroFocusedSessionId`, `preMaestroActiveSessionId`) are not in this list, so they are naturally excluded. No change needed — verify and move on.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/components/Sidebar.tsx
git commit -m "feat: integrate MaestroMode with hidden content and guarded keybindings"
```

### Task 12: Add MAESTRO badge to NavBar

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/NavBar.tsx`

- [ ] **Step 1: Subscribe to maestro state**

In `apps/desktop/src/renderer/src/components/NavBar.tsx`, after the existing store subscriptions, add:

```ts
  const maestroMode = useAppStore((s) => s.maestroMode)
```

- [ ] **Step 2: Add MAESTRO badge in the NavBar**

After the memory badge section (before the `{/* Terminal-area footer: centered actions */}` comment), add:

```tsx
        {/* Maestro mode badge */}
        {maestroMode && (
          <div
            className="flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest shrink-0"
            style={{
              color: txtColor,
              backgroundColor: `${wsColor}`,
              border: `1px solid ${txtColor}30`
            }}
          >
            MAESTRO
          </div>
        )}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/NavBar.tsx
git commit -m "feat: add MAESTRO badge to NavBar when mode is active"
```

### Task 13: Manual smoke test

- [ ] **Step 1: Run the dev build**

```bash
cd apps/desktop && bun run dev
```

- [ ] **Step 2: Verify basic flow**

1. Create a workspace, launch 2+ Claude/Codex agents
2. Press `Cmd+Shift+M` — should enter Maestro Mode with agent grid
3. Click panes to focus, type in focused pane
4. Press `Cmd+Left/Right` to cycle workspaces
5. Press `Cmd+Up/Down` to cycle pane focus
6. Press `Escape` to exit, verify previous session is restored
7. Verify MAESTRO badge appears/disappears in NavBar
8. Verify empty state when workspace has no agents
9. Verify `Cmd+W` closes the focused pane (not the pre-maestro session)
10. Verify `Cmd+N`/`Cmd+O` spawns new agents from within Maestro Mode
11. Verify exiting Maestro Mode shows original terminals intact (not re-created)

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: maestro mode smoke test fixes"
```
