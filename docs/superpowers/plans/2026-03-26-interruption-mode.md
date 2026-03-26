# Interruption Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace "Interruption Mode" that spawns a floating popup terminal window when an agent needs user input, regardless of app focus.

**Architecture:** A new `InterruptionPopupManager` class in the main process listens to the existing `idle-notification` flow and the `AgentSessionRegistry` state changes. When a session's `requiresUserInput` is true and its workspace has interruption mode enabled, the manager creates a frameless, always-on-top `BrowserWindow` loading a dedicated popup renderer. The popup attaches to the same daemon terminal session via the existing IPC bridge. When the agent transitions back to working, the popup closes.

**Tech Stack:** Electron BrowserWindow, xterm.js, React, electron-vite multi-page, zustand (existing)

---

### Task 1: Add types to shared/types.ts

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`

- [ ] **Step 1: Add InterruptionPosition type and workspace fields**

In `apps/desktop/src/shared/types.ts`, add the new type after the existing `Workspace` interface imports, and extend `Workspace`:

```ts
// Add after the Workspace interface (after line 33, before the closing brace or after linearConfig)
// Inside the Workspace interface, add these two new optional fields:
  interruptionMode?: boolean
  interruptionPosition?: InterruptionPosition
```

And add the type alias at the top level (after the Workspace interface):

```ts
export type InterruptionPosition = 'bottom-left' | 'bottom-right' | { x: number; y: number }
```

- [ ] **Step 2: Update the updateWorkspace Partial Pick type**

In `apps/desktop/src/renderer/src/store/app-store.ts`, find the `updateWorkspace` method signature (around line 286):

```ts
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'emoji' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings' | 'viewMode' | 'linearConfig'>>
  ) => void
```

Add the two new fields to the Pick union:

```ts
  updateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, 'name' | 'color' | 'emoji' | 'notificationSound' | 'questionNotificationSound' | 'repositorySettings' | 'viewMode' | 'linearConfig' | 'interruptionMode' | 'interruptionPosition'>>
  ) => void
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/txp/Pessoal/orchestra && bun run --filter @orchestra/desktop build 2>&1 | tail -20`
Expected: Build succeeds (the new fields are optional, so no other changes needed).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/renderer/src/store/app-store.ts
git commit -m "feat(interruption-mode): add InterruptionPosition type and workspace fields"
```

---

### Task 2: Create the InterruptionPopupManager in main process

**Files:**
- Create: `apps/desktop/src/main/interruption-popup.ts`
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Create interruption-popup.ts**

Create `apps/desktop/src/main/interruption-popup.ts`:

```ts
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { InterruptionPosition } from '../shared/types'

const POPUP_WIDTH = 800
const POPUP_HEIGHT = 400
const MARGIN = 16
const STACK_OFFSET = 30

interface PopupMeta {
  window: BrowserWindow
  sessionId: string
  workspaceId: string
}

const activePopups = new Map<string, PopupMeta>()

function getPopupPosition(
  position: InterruptionPosition | undefined,
  stackIndex: number,
): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  const pos = position ?? 'bottom-right'

  let x: number
  let y: number

  if (typeof pos === 'object') {
    x = pos.x
    y = pos.y
  } else if (pos === 'bottom-left') {
    x = workArea.x + MARGIN
    y = workArea.y + workArea.height - POPUP_HEIGHT - MARGIN
  } else {
    // bottom-right (default)
    x = workArea.x + workArea.width - POPUP_WIDTH - MARGIN
    y = workArea.y + workArea.height - POPUP_HEIGHT - MARGIN
  }

  // Stack offset for multiple popups
  x += stackIndex * STACK_OFFSET
  y -= stackIndex * STACK_OFFSET

  return { x, y }
}

export function showInterruptionPopup(
  sessionId: string,
  workspaceId: string,
  workspaceName: string,
  workspaceColor: string,
  sessionLabel: string,
  position: InterruptionPosition | undefined,
): void {
  // Don't create a duplicate popup for the same session
  if (activePopups.has(sessionId)) {
    const existing = activePopups.get(sessionId)!
    if (!existing.window.isDestroyed()) {
      existing.window.focus()
      return
    }
    activePopups.delete(sessionId)
  }

  const stackIndex = activePopups.size
  const { x, y } = getPopupPosition(position, stackIndex)

  const popup = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Pass session info via URL query params
  const params = new URLSearchParams({
    sessionId,
    workspaceId,
    workspaceName,
    workspaceColor,
    sessionLabel,
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    popup.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/popup.html?${params}`)
  } else {
    popup.loadFile(join(__dirname, '../renderer/popup.html'), {
      search: params.toString(),
    })
  }

  popup.once('ready-to-show', () => {
    popup.show()
    popup.focus()
  })

  popup.on('closed', () => {
    activePopups.delete(sessionId)
  })

  activePopups.set(sessionId, { window: popup, sessionId, workspaceId })
}

export function closeInterruptionPopup(sessionId: string): void {
  const meta = activePopups.get(sessionId)
  if (!meta) return
  if (!meta.window.isDestroyed()) {
    meta.window.close()
  }
  activePopups.delete(sessionId)
}

export function closeAllInterruptionPopups(workspaceId?: string): void {
  for (const [sessionId, meta] of activePopups) {
    if (workspaceId && meta.workspaceId !== workspaceId) continue
    if (!meta.window.isDestroyed()) {
      meta.window.close()
    }
    activePopups.delete(sessionId)
  }
}

export function hasActivePopup(sessionId: string): boolean {
  const meta = activePopups.get(sessionId)
  return !!meta && !meta.window.isDestroyed()
}
```

- [ ] **Step 2: Wire the popup manager into main/index.ts**

In `apps/desktop/src/main/index.ts`, add the import at the top (after the existing imports, around line 50):

```ts
import { showInterruptionPopup, closeInterruptionPopup, closeAllInterruptionPopups } from './interruption-popup'
```

Then, in the `createWindow` function, after the line that creates the `AgentSessionRegistry` (around line 155), modify the registry listener to also drive the popup manager. Replace the existing registry creation block:

```ts
  agentSessionRegistry = new AgentSessionRegistry((_sessionId, status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-session-state', status)
    }
  })
```

With:

```ts
  agentSessionRegistry = new AgentSessionRegistry((sessionId, status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-session-state', status)
    }

    // Interruption mode: close popup when agent goes back to working
    if (status.state === 'working' || status.state === 'unknown') {
      closeInterruptionPopup(sessionId)
    }
  })
```

- [ ] **Step 3: Hook into idle-notifier to trigger popups**

The existing `idle-notifier.ts` already emits `idle-notification` to the renderer with `requiresUserInput`. We need the main process to also trigger the popup. The cleanest approach is to add a callback in `idle-notifier.ts`.

In `apps/desktop/src/main/idle-notifier.ts`, add an optional callback and export a setter:

After `let pendingCriticalBounceId: number | null = null` (around line 102), add:

```ts
let onRequiresUserInput: ((sessionId: string, agentType: 'claude' | 'codex') => void) | null = null

export function setOnRequiresUserInput(
  callback: (sessionId: string, agentType: 'claude' | 'codex') => void,
): void {
  onRequiresUserInput = callback
}
```

Then inside `notifyIdleTransition`, after the line `mainWindow.webContents.send('idle-notification', { ... })` (around line 249), add:

```ts
  if (requiresUserInput && onRequiresUserInput) {
    onRequiresUserInput(sessionId, agentType)
  }
```

- [ ] **Step 4: Wire the idle-notifier callback in main/index.ts**

In `apps/desktop/src/main/index.ts`, update the import from `idle-notifier` to include the new function:

```ts
import { initIdleNotifier, setActiveSessionId, setOnRequiresUserInput } from './idle-notifier'
```

Then, after `initIdleNotifier(mainWindow)` (around line 167), add:

```ts
  setOnRequiresUserInput((sessionId, _agentType) => {
    const persisted = loadPersistedData()
    // Find which workspace owns this session
    let workspace: import('../shared/types').Workspace | null = null
    for (const ws of Object.values(persisted.workspaces)) {
      for (const tree of ws.trees) {
        if (tree.sessionIds.includes(sessionId)) {
          workspace = ws
          break
        }
      }
      if (workspace) break
    }
    if (!workspace || !workspace.interruptionMode) return

    const session = persisted.sessions[sessionId]
    const sessionLabel = session?.label ?? 'Terminal'

    showInterruptionPopup(
      sessionId,
      workspace.id,
      workspace.name,
      workspace.color,
      sessionLabel,
      workspace.interruptionPosition,
    )
  })
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/interruption-popup.ts apps/desktop/src/main/index.ts apps/desktop/src/main/idle-notifier.ts
git commit -m "feat(interruption-mode): add InterruptionPopupManager and wire to idle-notifier"
```

---

### Task 3: Create the popup renderer (HTML + React entry + component)

**Files:**
- Create: `apps/desktop/src/renderer/popup.html`
- Create: `apps/desktop/src/renderer/src/popup-entry.tsx`
- Create: `apps/desktop/src/renderer/src/components/PopupTerminal.tsx`
- Modify: `apps/desktop/electron.vite.config.ts`

- [ ] **Step 1: Create popup.html**

Create `apps/desktop/src/renderer/popup.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orchestra - Interruption</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/popup-entry.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create popup-entry.tsx**

Create `apps/desktop/src/renderer/src/popup-entry.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { PopupTerminal } from './components/PopupTerminal'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupTerminal />
  </React.StrictMode>
)
```

- [ ] **Step 3: Create PopupTerminal.tsx**

Create `apps/desktop/src/renderer/src/components/PopupTerminal.tsx`:

```tsx
import { useRef, useEffect, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { textColor } from '../utils/color'

const api = window.electronAPI

/** Strip xterm.js auto-responses (DA1/DA2/DA3) before relaying to PTY. */
const TERM_RESPONSE_RE = /\x1b\[[\?>][\d;]*[cRn]|\x1b\[[IO]|\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g

function stripTermResponses(data: string): string {
  return data.replace(TERM_RESPONSE_RE, '')
}

function getParams(): {
  sessionId: string
  workspaceName: string
  workspaceColor: string
  sessionLabel: string
} {
  const params = new URLSearchParams(window.location.search)
  return {
    sessionId: params.get('sessionId') ?? '',
    workspaceName: params.get('workspaceName') ?? 'Workspace',
    workspaceColor: params.get('workspaceColor') ?? '#1a1a2e',
    sessionLabel: params.get('sessionLabel') ?? 'Terminal',
  }
}

export function PopupTerminal() {
  const { sessionId, workspaceName, workspaceColor, sessionLabel } = getParams()
  const containerRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)

  const termBg = workspaceColor
  const fg = textColor(termBg)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      fontSize: 14,
      fontFamily: '"JetBrainsMono Nerd Font Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: termBg,
        foreground: fg,
        cursor: fg,
        cursorAccent: termBg,
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    // Send user input to PTY
    term.onData((raw) => {
      const data = stripTermResponses(raw)
      if (!data) return
      api.writeTerminal(sessionId, data)
    })

    // Receive PTY output
    let snapshotApplied = false
    const pendingData: string[] = []

    const removeDataListener = api.onTerminalData((sid: string, data: string) => {
      if (sid !== sessionId) return
      if (!snapshotApplied) {
        pendingData.push(data)
        return
      }
      term.write(data, () => term.scrollToBottom())
    })

    const removeSnapshotListener = api.onTerminalSnapshot((sid: string, snapshot: any) => {
      if (sid !== sessionId || !snapshot) return
      term.reset()
      if (snapshot.rehydrateSequences) term.write(snapshot.rehydrateSequences)
      if (snapshot.snapshotAnsi) term.write(snapshot.snapshotAnsi)
      snapshotApplied = true
      for (const chunk of pendingData.splice(0)) {
        term.write(chunk, () => term.scrollToBottom())
      }
    })

    // Request a snapshot to rehydrate the terminal with current content
    api.requestTerminalSnapshot(sessionId, { cols: term.cols, rows: term.rows }).then((snapshot) => {
      if (!snapshot) {
        // No snapshot available — just start showing live data
        snapshotApplied = true
        for (const chunk of pendingData.splice(0)) {
          term.write(chunk, () => term.scrollToBottom())
        }
        return
      }
      term.reset()
      if (snapshot.rehydrateSequences) term.write(snapshot.rehydrateSequences)
      if (snapshot.snapshotAnsi) term.write(snapshot.snapshotAnsi)
      snapshotApplied = true
      for (const chunk of pendingData.splice(0)) {
        term.write(chunk, () => term.scrollToBottom())
      }
    })

    // Auto-focus terminal
    term.focus()

    // Close on Escape
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.key === 'Escape') {
        window.close()
        return false
      }
      return true
    })

    // Resize terminal when container resizes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      api.resizeTerminal(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      removeDataListener()
      removeSnapshotListener()
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [sessionId])

  const handleClose = () => {
    setClosing(true)
    window.close()
  }

  if (!sessionId) {
    return <div style={{ color: '#fff', padding: 20 }}>Missing session ID</div>
  }

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{
        backgroundColor: termBg,
        borderRadius: 12,
        border: `1px solid ${fg}22`,
      }}
    >
      {/* Header — draggable */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 select-none"
        style={{
          WebkitAppRegion: 'drag' as any,
          borderBottom: `1px solid ${fg}15`,
        }}
      >
        {/* Color dot */}
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: workspaceColor, border: `1px solid ${fg}33` }}
        />
        {/* Workspace + session label */}
        <span className="text-xs font-medium truncate" style={{ color: fg + 'cc' }}>
          {workspaceName}
        </span>
        <span className="text-xs truncate" style={{ color: fg + '88' }}>
          {sessionLabel}
        </span>
        {/* Spacer */}
        <div className="flex-1" />
        {/* Close button */}
        <button
          onClick={handleClose}
          className="text-xs px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
          style={{
            color: fg + '88',
            WebkitAppRegion: 'no-drag' as any,
          }}
        >
          ×
        </button>
      </div>

      {/* Terminal body */}
      <div ref={containerRef} className="flex-1 p-2 overflow-hidden" />
    </div>
  )
}
```

- [ ] **Step 4: Update electron.vite.config.ts to add popup entry**

In `apps/desktop/electron.vite.config.ts`, the `renderer` section needs a multi-page config. Modify the renderer section to add the popup entry:

```ts
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [tailwindcss(), react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          popup: resolve('src/renderer/popup.html'),
        }
      }
    }
  }
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/txp/Pessoal/orchestra && bun run --filter @orchestra/desktop build 2>&1 | tail -20`
Expected: Build succeeds with both renderer entries compiled.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/popup.html apps/desktop/src/renderer/src/popup-entry.tsx apps/desktop/src/renderer/src/components/PopupTerminal.tsx apps/desktop/electron.vite.config.ts
git commit -m "feat(interruption-mode): add popup renderer with xterm.js terminal"
```

---

### Task 4: Add Interruption Mode settings to workspace settings UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`

- [ ] **Step 1: Add props to SettingsDialogProps**

In `apps/desktop/src/renderer/src/components/SettingsDialog.tsx`, add to the `SettingsDialogProps` interface (after `onSaveLinearConfig`):

```ts
  interruptionMode?: boolean
  interruptionPosition?: import('../../../shared/types').InterruptionPosition
  onUpdateInterruptionMode: (enabled: boolean) => void
  onUpdateInterruptionPosition: (position: import('../../../shared/types').InterruptionPosition) => void
```

Add these to the destructured props in the function signature.

- [ ] **Step 2: Add state for interruption settings**

After the existing state declarations (around line 80), add:

```ts
  const [interruptionEnabled, setInterruptionEnabled] = useState(interruptionMode ?? false)
  const [interruptionPos, setInterruptionPos] = useState<'bottom-left' | 'bottom-right' | 'custom'>(
    typeof interruptionPosition === 'object' ? 'custom' :
    interruptionPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right'
  )
  const [customX, setCustomX] = useState(typeof interruptionPosition === 'object' ? interruptionPosition.x : 0)
  const [customY, setCustomY] = useState(typeof interruptionPosition === 'object' ? interruptionPosition.y : 0)
```

- [ ] **Step 3: Add "Interruption Mode" entry to the settings index page**

In the index page section, after the "Notifications" `SettingsMenuItem` (around line 250), add:

```tsx
              <SettingsMenuItem
                title="Interruption Mode"
                description={interruptionEnabled ? 'Enabled' : 'Disabled'}
                onClick={() => setPage('interruption')}
                txt={txt}
                mutedTxt={mutedTxt}
                light={light}
              />
```

Update the `SettingsPage` type to include `'interruption'`:

```ts
type SettingsPage = 'index' | 'appearance' | 'notifications' | 'actions' | 'repository' | 'worktrees' | 'linear' | 'interruption'
```

- [ ] **Step 4: Add the interruption mode settings page**

After the notifications page block (after line 365, before the actions page), add:

```tsx
        {/* ---- Interruption Mode page ---- */}
        {page === 'interruption' && (
          <>
            <PageHeader title="Interruption Mode" onBack={() => setPage('index')} txt={txt} />
            <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
              <Toggle
                label="Enable interruption popups"
                value={interruptionEnabled}
                onChange={(v) => {
                  setInterruptionEnabled(v)
                  onUpdateInterruptionMode(v)
                }}
                txt={txt}
                mutedTxt={mutedTxt}
              />
              <p className="text-xs px-2" style={{ color: mutedTxt }}>
                When enabled, a floating terminal popup appears whenever an agent needs your input — even if Orchestra is not focused.
              </p>

              {interruptionEnabled && (
                <div className="space-y-3 pt-2">
                  <label className="text-xs font-medium px-2" style={{ color: txt }}>
                    Popup position
                  </label>
                  <div className="flex gap-2 px-2">
                    {(['bottom-left', 'bottom-right', 'custom'] as const).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => {
                          setInterruptionPos(opt)
                          if (opt !== 'custom') {
                            onUpdateInterruptionPosition(opt)
                          }
                        }}
                        className="text-xs px-3 py-1.5 rounded transition-colors"
                        style={{
                          backgroundColor: interruptionPos === opt ? fg + '22' : 'transparent',
                          color: interruptionPos === opt ? txt : mutedTxt,
                          border: `1px solid ${interruptionPos === opt ? fg + '33' : 'transparent'}`,
                        }}
                      >
                        {opt === 'bottom-left' ? 'Bottom Left' : opt === 'bottom-right' ? 'Bottom Right' : 'Custom'}
                      </button>
                    ))}
                  </div>

                  {interruptionPos === 'custom' && (
                    <div className="flex gap-3 px-2 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: mutedTxt }}>X</span>
                        <input
                          type="number"
                          value={customX}
                          onChange={(e) => {
                            const x = parseInt(e.target.value, 10) || 0
                            setCustomX(x)
                            onUpdateInterruptionPosition({ x, y: customY })
                          }}
                          className="w-20 text-xs px-2 py-1 rounded outline-none"
                          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: mutedTxt }}>Y</span>
                        <input
                          type="number"
                          value={customY}
                          onChange={(e) => {
                            const y = parseInt(e.target.value, 10) || 0
                            setCustomY(y)
                            onUpdateInterruptionPosition({ x: customX, y })
                          }}
                          className="w-20 text-xs px-2 py-1 rounded outline-none"
                          style={{ backgroundColor: inputBg, border: `1px solid ${inputBorder}`, color: txt }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/SettingsDialog.tsx
git commit -m "feat(interruption-mode): add interruption mode settings page"
```

---

### Task 5: Wire SettingsDialog props from the parent component

**Files:**
- Modify: The parent component that renders `SettingsDialog` (likely `apps/desktop/src/renderer/src/App.tsx` or `Sidebar.tsx`)

- [ ] **Step 1: Find where SettingsDialog is rendered**

Search for `<SettingsDialog` usage to find the parent. It's rendered in `App.tsx`.

Read the file to find the exact location and existing prop-passing pattern.

- [ ] **Step 2: Pass the new interruption mode props**

In the component that renders `<SettingsDialog>`, add the new props. The workspace data is already available from the store. Add:

```tsx
  interruptionMode={activeWorkspace.interruptionMode}
  interruptionPosition={activeWorkspace.interruptionPosition}
  onUpdateInterruptionMode={(enabled) => {
    updateWorkspace(activeWorkspace.id, { interruptionMode: enabled })
  }}
  onUpdateInterruptionPosition={(position) => {
    updateWorkspace(activeWorkspace.id, { interruptionPosition: position })
  }}
```

The `updateWorkspace` call already uses `{ ...workspace, ...updates }` spreading (see `app-store.ts:522-533`), so the new fields will be persisted automatically via the existing `saveState` flow.

- [ ] **Step 3: Verify build**

Run: `cd /Users/txp/Pessoal/orchestra && bun run --filter @orchestra/desktop build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(interruption-mode): wire interruption mode props to SettingsDialog"
```

---

### Task 6: Handle popup dismissal on session exit and workspace toggle-off

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Close popup on terminal exit**

In `apps/desktop/src/main/index.ts`, find the terminal exit IPC handler. The daemon client emits terminal exit events that get forwarded to the renderer. Find where `terminal-exit` is sent to the renderer (this is in the daemon client's stream event handler).

In the `createWindow` function, after the daemon client is connected and the popup manager is initialized, add a listener. The daemon client has an event for session exit. Find the stream handler that forwards `terminal-exit` events and add popup cleanup there.

Look for where `terminal-exit` is sent — likely in the daemon-client event forwarding. After that line, add:

```ts
closeInterruptionPopup(sessionId)
```

If the terminal-exit forwarding is inside the daemon client itself, add an IPC handler in `index.ts`:

After the existing `terminal-kill` handler (around line 322), add a listener to the renderer's save-state flow. Actually, the simplest approach: the `AgentSessionRegistry` listener already closes popups when state goes to `working`. For session exit, add to the daemon client's stream handler where it emits `terminal-exit`:

In the stream handling code (inside daemon-client or wherever `terminal-exit` is forwarded), add:

```ts
import { closeInterruptionPopup } from './interruption-popup'
```

And in the exit handler:

```ts
closeInterruptionPopup(sessionId)
```

Alternatively, since the session gets unregistered from the `AgentSessionRegistry` on exit, add cleanup in the `unregister` method or in the process-monitor's session cleanup.

The most reliable place is to hook into the renderer's `onTerminalExit` flow. Since the main process forwards the exit event, add the cleanup right where `terminal-exit` is sent:

Find the daemon client stream handler that does `mainWindow.webContents.send('terminal-exit', sessionId)` and add `closeInterruptionPopup(sessionId)` right after it.

- [ ] **Step 2: Close popups when interruption mode is toggled off**

The workspace update happens in the renderer via `updateWorkspace`, which calls `saveState`. The main process receives the `save-state` IPC. To detect when interruption mode is turned off, listen for workspace changes in the main process.

In `apps/desktop/src/main/index.ts`, find the `save-state` IPC handler and add after it:

```ts
ipcMain.on('interruption-mode-changed', (_, workspaceId: string, enabled: boolean) => {
  if (!enabled) {
    closeAllInterruptionPopups(workspaceId)
  }
})
```

Then in the `SettingsDialog.tsx` `onUpdateInterruptionMode` callback, also send this IPC:

In `apps/desktop/src/preload/index.ts`, add a new API method:

```ts
  interruptionModeChanged: (workspaceId: string, enabled: boolean) => {
    ipcRenderer.send('interruption-mode-changed', workspaceId, enabled)
  },
```

Add to the `ElectronAPI` interface in `apps/desktop/src/shared/types.ts`:

```ts
  interruptionModeChanged: (workspaceId: string, enabled: boolean) => void
```

Call it from the `onUpdateInterruptionMode` callback in the parent component:

```ts
  onUpdateInterruptionMode={(enabled) => {
    updateWorkspace(activeWorkspace.id, { interruptionMode: enabled })
    window.electronAPI.interruptionModeChanged(activeWorkspace.id, enabled)
  }}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/txp/Pessoal/orchestra && bun run --filter @orchestra/desktop build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/idle-notifier.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/types.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(interruption-mode): handle popup dismissal on session exit and mode toggle-off"
```

---

### Task 7: Manual integration test

**Files:** None (testing only)

- [ ] **Step 1: Start the app in dev mode**

Run: `cd /Users/txp/Pessoal/orchestra && bun run --filter @orchestra/desktop dev`

- [ ] **Step 2: Enable interruption mode on a workspace**

1. Open workspace settings (gear icon)
2. Navigate to "Interruption Mode"
3. Toggle on "Enable interruption popups"
4. Set position to "Bottom Right"
5. Close settings

- [ ] **Step 3: Trigger a popup**

1. Start a Claude Code session in that workspace
2. Give it a task that will result in a question (e.g., ask it to do something ambiguous)
3. Switch away from Orchestra (click on another app)
4. Wait for Claude to ask a question

Expected: A floating 800x400 popup appears at bottom-right of screen, showing the terminal with Claude's question. The popup is always-on-top and focused.

- [ ] **Step 4: Respond and verify dismissal**

1. Type a response in the popup terminal
2. Press Enter

Expected: Claude starts working. Within a few seconds, the popup closes automatically as the agent transitions to "working" state.

- [ ] **Step 5: Test manual close**

1. Trigger another popup
2. Press Escape or click the × button

Expected: Popup closes. The session continues normally in the main window.

- [ ] **Step 6: Test toggle-off**

1. Open workspace settings
2. Turn off interruption mode
3. If any popups are open, they should close

Expected: All popups for this workspace close immediately.
