# Idle Notification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Notify users when Claude/Codex sessions finish working, with a toast (app focused) or macOS notification (app not focused), showing a 3-4 word prompt summary.

**Architecture:** The main process detects working→idle transitions in the existing `emitWorkState` functions. A new `idle-notifier.ts` module orchestrates: checks if the session is active, fetches the last prompt, summarizes it, then dispatches either an IPC event (for in-app toast) or an Electron `Notification` (for native). The renderer renders a `Toast` component from the IPC event.

**Tech Stack:** Electron Notification API, IPC channels, React component, Tailwind CSS, existing `prompt-summarizer.ts`

---

### Task 1: Add `IdleNotification` type and IPC channel to shared types

**Files:**
- Modify: `apps/desktop/src/shared/types.ts`

**Step 1: Add the IdleNotification interface and extend ElectronAPI**

In `apps/desktop/src/shared/types.ts`, after line 75 (`export type CodexWorkState = 'idle' | 'working'`), add:

```typescript
export interface IdleNotification {
  sessionId: string
  summary: string  // e.g. "Deploy auth fix is ready"
  agentType: 'claude' | 'codex'
}
```

Then in the `ElectronAPI` interface, after the `onCodexWorkState` line (~119), add:

```typescript
onIdleNotification: (callback: (notification: IdleNotification) => void) => () => void
navigateToSession: (sessionId: string) => void
```

**Step 2: Commit**

```bash
git add apps/desktop/src/shared/types.ts
git commit -m "feat: add IdleNotification type and IPC channel definition"
```

---

### Task 2: Create `idle-notifier.ts` in main process

**Files:**
- Create: `apps/desktop/src/main/idle-notifier.ts`

**Step 1: Create the idle notifier module**

```typescript
// src/main/idle-notifier.ts
// Orchestrates idle notifications: checks active session, summarizes prompt,
// dispatches in-app toast (focused) or native macOS notification (not focused).

import { BrowserWindow, Notification } from 'electron'
import { summarizePrompt } from './prompt-summarizer'
import { getDaemonClient } from './daemon-client'

let mainWindow: BrowserWindow | null = null
let activeSessionId: string | null = null

export function initIdleNotifier(window: BrowserWindow): void {
  mainWindow = window
}

export function setActiveSessionId(sessionId: string | null): void {
  activeSessionId = sessionId
}

export async function notifyIdleTransition(
  sessionId: string,
  agentType: 'claude' | 'codex'
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (sessionId === activeSessionId) return

  // Get the last prompt for this session
  let summary: string
  try {
    const history = await getDaemonClient().getPromptHistory(sessionId)
    const lastPrompt = history[history.length - 1]?.text
    if (lastPrompt) {
      summary = await summarizePrompt(lastPrompt)
    } else {
      summary = agentType === 'claude' ? 'Claude' : 'Codex'
    }
  } catch {
    summary = agentType === 'claude' ? 'Claude' : 'Codex'
  }

  const message = `${summary} is ready`

  if (mainWindow.isFocused()) {
    // In-app toast
    mainWindow.webContents.send('idle-notification', {
      sessionId,
      summary: message,
      agentType
    })
  } else {
    // Native macOS notification
    const notification = new Notification({
      title: 'Orchestra',
      body: message,
      silent: false
    })

    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('navigate-to-session', sessionId)
      }
    })

    notification.show()
  }
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/main/idle-notifier.ts
git commit -m "feat: add idle-notifier module for working→idle notifications"
```

---

### Task 3: Wire idle notifier into session watchers and main process

**Files:**
- Modify: `apps/desktop/src/main/claude-session-watcher.ts` (line 348, `emitWorkState`)
- Modify: `apps/desktop/src/main/codex-session-watcher.ts` (line 212, `emitWorkState`)
- Modify: `apps/desktop/src/main/index.ts`

**Step 1: Add idle notification call in Claude's emitWorkState**

In `claude-session-watcher.ts`, add import at top:

```typescript
import { notifyIdleTransition } from './idle-notifier'
```

In the `emitWorkState` function (line 348), after the existing `mainWindow.webContents.send(...)` call (line 359), add:

```typescript
  if (nextState === 'idle') {
    void notifyIdleTransition(entry.sessionId, 'claude')
  }
```

**Step 2: Add idle notification call in Codex's emitWorkState**

In `codex-session-watcher.ts`, add import at top:

```typescript
import { notifyIdleTransition } from './idle-notifier'
```

In the `emitWorkState` function (line 212), after the existing `mainWindow.webContents.send(...)` call (line 224), add:

```typescript
  if (nextState === 'idle') {
    void notifyIdleTransition(entry.sessionId, 'codex')
  }
```

**Step 3: Initialize idle notifier and add IPC handlers in main/index.ts**

In `apps/desktop/src/main/index.ts`, add import:

```typescript
import { initIdleNotifier, setActiveSessionId } from './idle-notifier'
```

After `initCodexWatcher(mainWindow)` (line 95), add:

```typescript
  initIdleNotifier(mainWindow)
```

Add IPC handler for active session tracking (after the save-state handler, ~line 204):

```typescript
ipcMain.on('set-active-session', (_, sessionId: string | null) => {
  setActiveSessionId(sessionId)
})
```

**Step 4: Commit**

```bash
git add apps/desktop/src/main/claude-session-watcher.ts apps/desktop/src/main/codex-session-watcher.ts apps/desktop/src/main/index.ts
git commit -m "feat: wire idle notifier into session watchers and main process"
```

---

### Task 4: Add IPC bindings in preload

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Step 1: Add imports and IPC bindings**

Add `IdleNotification` to the import from `'../shared/types'`:

```typescript
import type { ElectronAPI, CreateTerminalOpts, ProcessStatus, ClaudeWorkState, CodexWorkState, WriteSource, IdleNotification } from '../shared/types'
```

Add these methods to the `api` object, before the `removeAllListeners` method:

```typescript
  onIdleNotification: (callback: (notification: IdleNotification) => void) => {
    const handler = (_event: any, notification: IdleNotification) => callback(notification)
    ipcRenderer.on('idle-notification', handler)
    return () => { ipcRenderer.removeListener('idle-notification', handler) }
  },
  navigateToSession: (sessionId: string) => {
    ipcRenderer.send('set-active-session', sessionId)
  },
```

Add cleanup in `removeAllListeners`:

```typescript
    ipcRenderer.removeAllListeners('idle-notification')
    ipcRenderer.removeAllListeners('navigate-to-session')
```

**Step 2: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat: expose idle notification IPC in preload bridge"
```

---

### Task 5: Create Toast component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/Toast.tsx`

**Step 1: Create the Toast component**

```tsx
import { useEffect, useState } from 'react'
import type { IdleNotification } from '../../../shared/types'
import { DynamicIcon } from './DynamicIcon'

interface ToastEntry extends IdleNotification {
  id: string
  fadingOut: boolean
}

interface ToastProps {
  notifications: ToastEntry[]
  onDismiss: (id: string) => void
  onNavigate: (sessionId: string) => void
}

export function ToastContainer({ notifications, onDismiss, onNavigate }: ToastProps) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {notifications.map((n) => (
        <ToastItem
          key={n.id}
          entry={n}
          onDismiss={() => onDismiss(n.id)}
          onNavigate={() => onNavigate(n.sessionId)}
        />
      ))}
    </div>
  )
}

function ToastItem({
  entry,
  onDismiss,
  onNavigate
}: {
  entry: ToastEntry
  onDismiss: () => void
  onNavigate: () => void
}) {
  const icon = entry.agentType === 'claude' ? '__claude__' : '__openai__'

  return (
    <button
      onClick={() => {
        onNavigate()
        onDismiss()
      }}
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg cursor-pointer
        transition-all duration-300 hover:scale-[1.02] hover:brightness-110
        ${entry.fadingOut ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0 animate-toast-in'}`}
      style={{ backgroundColor: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      <span className="shrink-0 opacity-80">
        <DynamicIcon name={icon} size={18} color="#fff" />
      </span>
      <span className="text-sm text-white/90 whitespace-nowrap">{entry.summary}</span>
    </button>
  )
}

export type { ToastEntry }
```

**Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/Toast.tsx
git commit -m "feat: add Toast component for idle notifications"
```

---

### Task 6: Add toast animation CSS

**Files:**
- Modify: `apps/desktop/src/renderer/src/index.css`

**Step 1: Add toast-in animation**

At the end of `index.css`, add:

```css
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateX(1rem);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.animate-toast-in {
  animation: toast-in 0.3s ease-out;
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/index.css
git commit -m "feat: add toast slide-in animation"
```

---

### Task 7: Wire toast into App.tsx with useIdleNotifications hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/useIdleNotifications.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

**Step 1: Create the useIdleNotifications hook**

```typescript
import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { IdleNotification } from '../../../shared/types'
import type { ToastEntry } from '../components/Toast'

export function useIdleNotifications() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissToast = useCallback((id: string) => {
    // Start fade-out
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, fadingOut: true } : t))
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 300)
    // Clear auto-dismiss timer
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const navigateToSession = useCallback((sessionId: string) => {
    useAppStore.getState().setActiveSession(sessionId)
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.onIdleNotification((notification: IdleNotification) => {
      const id = crypto.randomUUID()
      const entry: ToastEntry = { ...notification, id, fadingOut: false }
      setToasts((prev) => [...prev, entry])

      // Auto-dismiss after 5s
      const timer = setTimeout(() => {
        dismissToast(id)
        timersRef.current.delete(id)
      }, 5000)
      timersRef.current.set(id, timer)
    })

    // Also listen for native notification clicks (navigate-to-session)
    const handleNavigate = (_event: any, sessionId: string) => {
      useAppStore.getState().setActiveSession(sessionId)
    }
    // @ts-ignore - direct ipcRenderer access not available, handled via preload
    // Native notification clicks are handled by the main process sending navigate-to-session

    return () => {
      cleanup()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [dismissToast])

  return { toasts, dismissToast, navigateToSession }
}
```

**Step 2: Add ToastContainer to App.tsx**

In `App.tsx`, add imports:

```typescript
import { ToastContainer } from './components/Toast'
import { useIdleNotifications } from './hooks/useIdleNotifications'
```

Inside the `App` component, after `useAgentResponses()`, add:

```typescript
  const { toasts, dismissToast, navigateToSession } = useIdleNotifications()
```

Inside the JSX, just before the closing `</div>` of the root element (before line 124), add:

```tsx
      <ToastContainer
        notifications={toasts}
        onDismiss={dismissToast}
        onNavigate={navigateToSession}
      />
```

**Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/useIdleNotifications.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat: wire idle notification toasts into App"
```

---

### Task 8: Track active session in main process

**Files:**
- Modify: `apps/desktop/src/renderer/src/store/app-store.ts`

**Step 1: Send active session changes to main process**

The `setActiveSession` method already updates `activeSessionId` in the store. We need to notify the main process. In the `App.tsx` persist effect (the `useEffect` with `useAppStore.subscribe`), the active session is already sent via `saveState`. But that's debounced by 1s — too slow for notification gating.

Add a dedicated effect in `App.tsx`, after the existing `useEffect` blocks:

```typescript
  // Keep main process in sync with active session for notification gating
  useEffect(() => {
    const unsub = useAppStore.subscribe(
      (state) => state.activeSessionId,
      (activeSessionId) => {
        window.electronAPI.navigateToSession(activeSessionId ?? '')
      }
    )
    // Send initial value
    const initial = useAppStore.getState().activeSessionId
    if (initial) window.electronAPI.navigateToSession(initial)
    return unsub
  }, [])
```

Wait — zustand's `subscribe` with a selector requires the `subscribeWithSelector` middleware. Instead, use a simpler approach in the existing subscribe:

In `App.tsx`, add a new `useEffect` after the persist effect:

```typescript
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  useEffect(() => {
    window.electronAPI.navigateToSession(activeSessionId ?? '')
  }, [activeSessionId])
```

This uses React's reactivity to send updates immediately when `activeSessionId` changes.

**Note:** The `navigateToSession` preload method sends `set-active-session` IPC which calls `setActiveSessionId()` in `idle-notifier.ts`. This serves dual purpose: active session tracking AND navigation from native notification clicks.

**Step 2: Handle navigate-to-session from native notification clicks**

In `App.tsx`, inside the initial `useEffect` (the one with `getPersistedData`), add a listener for `navigate-to-session`:

We need to add this to preload first. In `preload/index.ts`, add to the api object:

```typescript
  onNavigateToSession: (callback: (sessionId: string) => void) => {
    const handler = (_event: any, sessionId: string) => callback(sessionId)
    ipcRenderer.on('navigate-to-session', handler)
    return () => { ipcRenderer.removeListener('navigate-to-session', handler) }
  },
```

Add to `ElectronAPI` in types.ts:

```typescript
  onNavigateToSession: (callback: (sessionId: string) => void) => () => void
```

Add to `removeAllListeners`:

```typescript
    ipcRenderer.removeAllListeners('navigate-to-session')
```

Then in `App.tsx`, inside the initial useEffect, add:

```typescript
    const unsubNavigate = window.electronAPI.onNavigateToSession((sessionId) => {
      useAppStore.getState().setActiveSession(sessionId)
    })
```

And in the cleanup: `unsubNavigate()`

**Step 3: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/App.tsx
git commit -m "feat: track active session in main process and handle native notification navigation"
```

---

### Task 9: Build and test

**Step 1: Build**

```bash
cd apps/desktop && bun run build
```

Fix any TypeScript errors.

**Step 2: Manual test plan**

1. Open Orchestra, create a workspace with 2+ sessions
2. Start Claude in Session 1, give it a task
3. Switch to Session 2
4. Wait for Claude to finish → expect toast in bottom-right with "{summary} is ready"
5. Click the toast → should navigate to Session 1
6. Repeat but minimize/unfocus the app → expect macOS notification
7. Click the macOS notification → app should focus and navigate to Session 1
8. Stay on Session 1 while Claude finishes → expect NO notification

**Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: address build and integration issues"
```

---

## Summary of all new/modified files

| File | Action |
|------|--------|
| `src/shared/types.ts` | Add `IdleNotification`, extend `ElectronAPI` |
| `src/main/idle-notifier.ts` | **New** — orchestrate notification dispatch |
| `src/main/claude-session-watcher.ts` | Call `notifyIdleTransition` on idle |
| `src/main/codex-session-watcher.ts` | Call `notifyIdleTransition` on idle |
| `src/main/index.ts` | Init notifier, add `set-active-session` IPC |
| `src/preload/index.ts` | Expose `onIdleNotification`, `navigateToSession`, `onNavigateToSession` |
| `src/renderer/src/components/Toast.tsx` | **New** — toast UI component |
| `src/renderer/src/hooks/useIdleNotifications.ts` | **New** — hook for toast state |
| `src/renderer/src/App.tsx` | Render toasts, track active session, handle navigation |
| `src/renderer/src/index.css` | Add toast-in animation |
