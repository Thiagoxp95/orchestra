# Orchestra Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Electron desktop app that orchestrates terminal sessions in color-coded workspaces with AI tool detection and session persistence.

**Architecture:** Electron main process manages PTYs (node-pty), process monitoring, and persistence (electron-store). Renderer uses React 19 + xterm.js + Zustand. IPC bridge via preload with contextIsolation.

**Tech Stack:** Electron, electron-vite, bun, React 19, Tailwind CSS, hugeicons-react, xterm.js, node-pty, Zustand, electron-store, react-colorful

---

### Task 1: Scaffold Electron + React project with electron-vite

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `tailwind.config.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`

**Step 1: Initialize electron-vite project**

```bash
cd /Users/txp/Pessoal/orchestra
bunx create-electron-vite@latest . -- --template react-ts
```

If the scaffolder doesn't support `.` as target, create in a temp name and move files. The template gives us the full Electron + React + TypeScript setup.

**Step 2: Install dependencies**

```bash
bun add xterm @xterm/addon-fit @xterm/addon-webgl node-pty electron-store zustand react-colorful hugeicons-react
bun add -d tailwindcss @tailwindcss/vite
```

**Step 3: Configure Tailwind**

Add Tailwind to `electron.vite.config.ts` renderer vite config:

```typescript
import tailwindcss from '@tailwindcss/vite'

// In the renderer config plugins array:
plugins: [tailwindcss(), react()]
```

Create `src/renderer/index.css` with:

```css
@import "tailwindcss";
```

Import it in `src/renderer/main.tsx`.

**Step 4: Verify it runs**

```bash
bun run dev
```

Expected: Electron window opens with the default React template content.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: scaffold electron-vite project with React, Tailwind, and dependencies"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/shared/types.ts`

**Step 1: Create shared types file**

```typescript
// src/shared/types.ts

export interface Workspace {
  id: string
  name: string
  color: string
  sessionIds: string[]
  createdAt: number
}

export interface TerminalSession {
  id: string
  workspaceId: string
  label: string
  processStatus: ProcessStatus
  cwd: string
  shellPath: string
}

export type ProcessStatus = 'terminal' | 'claude' | 'codex'

export interface PersistedData {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession & {
    scrollback: string
    env: Record<string, string>
  }>
  activeWorkspaceId: string | null
  activeSessionId: string | null
}

export interface CreateTerminalOpts {
  cwd: string
  shell?: string
}

export interface ElectronAPI {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => void
  killTerminal: (sessionId: string) => void
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void
  writeTerminal: (sessionId: string, data: string) => void
  onTerminalData: (callback: (sessionId: string, data: string) => void) => void
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus) => void) => void
  onTerminalExit: (callback: (sessionId: string) => void) => void
  captureScrollback: (sessionId: string) => Promise<string>
  getCwd: (sessionId: string) => Promise<string>
  getPersistedData: () => Promise<PersistedData | null>
  removeAllListeners: () => void
}
```

**Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add shared type definitions for workspaces, sessions, and IPC API"
```

---

### Task 3: Persistence layer (main process)

**Files:**
- Create: `src/main/persistence.ts`

**Step 1: Implement persistence module**

```typescript
// src/main/persistence.ts
import Store from 'electron-store'
import type { PersistedData, Workspace, TerminalSession } from '../shared/types'

const store = new Store<{ data: PersistedData }>({
  name: 'orchestra-data',
  defaults: {
    data: {
      workspaces: {},
      sessions: {},
      activeWorkspaceId: null,
      activeSessionId: null
    }
  }
})

export function loadPersistedData(): PersistedData {
  return store.get('data')
}

export function savePersistedData(data: PersistedData): void {
  store.set('data', data)
}

export function saveWorkspaces(
  workspaces: Record<string, Workspace>,
  sessions: Record<string, TerminalSession>,
  activeWorkspaceId: string | null,
  activeSessionId: string | null
): void {
  const current = loadPersistedData()
  // Preserve scrollback/env from existing persisted sessions
  const mergedSessions: PersistedData['sessions'] = {}
  for (const [id, session] of Object.entries(sessions)) {
    mergedSessions[id] = {
      ...session,
      scrollback: current.sessions[id]?.scrollback ?? '',
      env: current.sessions[id]?.env ?? {}
    }
  }
  store.set('data', {
    workspaces,
    sessions: mergedSessions,
    activeWorkspaceId,
    activeSessionId
  })
}

export function saveSessionScrollback(sessionId: string, scrollback: string, cwd: string): void {
  const data = loadPersistedData()
  if (data.sessions[sessionId]) {
    data.sessions[sessionId].scrollback = scrollback
    data.sessions[sessionId].cwd = cwd
    store.set('data', data)
  }
}
```

**Step 2: Commit**

```bash
git add src/main/persistence.ts
git commit -m "feat: add persistence layer using electron-store"
```

---

### Task 4: PTY Manager (main process)

**Files:**
- Create: `src/main/pty-manager.ts`

**Step 1: Implement PTY manager**

```typescript
// src/main/pty-manager.ts
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'node:os'
import type { CreateTerminalOpts } from '../shared/types'

const ptys = new Map<string, pty.IPty>()

function getDefaultShell(): string {
  return process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
}

export function createPty(
  sessionId: string,
  opts: CreateTerminalOpts,
  window: BrowserWindow
): number {
  const shell = opts.shell || getDefaultShell()
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
    env: process.env as Record<string, string>
  })

  ptyProcess.onData((data) => {
    window.webContents.send('terminal-data', sessionId, data)
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
    window.webContents.send('terminal-exit', sessionId)
  })

  ptys.set(sessionId, ptyProcess)
  return ptyProcess.pid
}

export function writePty(sessionId: string, data: string): void {
  ptys.get(sessionId)?.write(data)
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  ptys.get(sessionId)?.resize(cols, rows)
}

export function killPty(sessionId: string): void {
  const p = ptys.get(sessionId)
  if (p) {
    p.kill()
    ptys.delete(sessionId)
  }
}

export function getPtyPid(sessionId: string): number | undefined {
  return ptys.get(sessionId)?.pid
}

export function getAllSessionIds(): string[] {
  return Array.from(ptys.keys())
}

export function killAll(): void {
  for (const [id] of ptys) {
    killPty(id)
  }
}
```

**Step 2: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "feat: add PTY manager for spawning and managing terminal processes"
```

---

### Task 5: Process Monitor (main process)

**Files:**
- Create: `src/main/process-monitor.ts`

**Step 1: Implement process monitor**

```typescript
// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { ProcessStatus } from '../shared/types'
import { getPtyPid, getAllSessionIds } from './pty-manager'

const lastStatus = new Map<string, ProcessStatus>()
let interval: ReturnType<typeof setInterval> | null = null

function detectProcess(pid: number): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-lP', String(pid)], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('terminal')
        return
      }
      const lines = stdout.trim().toLowerCase()
      if (lines.includes('claude')) {
        resolve('claude')
      } else if (lines.includes('codex')) {
        resolve('codex')
      } else {
        resolve('terminal')
      }
    })
  })
}

export function startMonitoring(window: BrowserWindow): void {
  if (interval) return

  interval = setInterval(async () => {
    const sessionIds = getAllSessionIds()
    for (const sessionId of sessionIds) {
      const pid = getPtyPid(sessionId)
      if (!pid) continue

      const status = await detectProcess(pid)
      const prev = lastStatus.get(sessionId)
      if (status !== prev) {
        lastStatus.set(sessionId, status)
        window.webContents.send('process-change', sessionId, status)
      }
    }
  }, 2000)
}

export function stopMonitoring(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  lastStatus.clear()
}
```

**Step 2: Commit**

```bash
git add src/main/process-monitor.ts
git commit -m "feat: add process monitor to detect claude/codex in terminal sessions"
```

---

### Task 6: Preload script (IPC bridge)

**Files:**
- Modify: `src/preload/index.ts`

**Step 1: Implement the IPC bridge**

Replace the contents of `src/preload/index.ts` with:

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, CreateTerminalOpts, ProcessStatus } from '../shared/types'

const api: ElectronAPI = {
  createTerminal: (sessionId: string, opts: CreateTerminalOpts) => {
    ipcRenderer.send('terminal-create', sessionId, opts)
  },
  killTerminal: (sessionId: string) => {
    ipcRenderer.send('terminal-kill', sessionId)
  },
  resizeTerminal: (sessionId: string, cols: number, rows: number) => {
    ipcRenderer.send('terminal-resize', sessionId, cols, rows)
  },
  writeTerminal: (sessionId: string, data: string) => {
    ipcRenderer.send('terminal-write', sessionId, data)
  },
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data))
  },
  onProcessChange: (callback: (sessionId: string, status: ProcessStatus) => void) => {
    ipcRenderer.on('process-change', (_event, sessionId, status) => callback(sessionId, status))
  },
  onTerminalExit: (callback: (sessionId: string) => void) => {
    ipcRenderer.on('terminal-exit', (_event, sessionId) => callback(sessionId))
  },
  captureScrollback: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-capture-scrollback', sessionId)
  },
  getCwd: (sessionId: string) => {
    return ipcRenderer.invoke('terminal-get-cwd', sessionId)
  },
  getPersistedData: () => {
    return ipcRenderer.invoke('get-persisted-data')
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('terminal-data')
    ipcRenderer.removeAllListeners('process-change')
    ipcRenderer.removeAllListeners('terminal-exit')
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
```

**Step 2: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat: implement preload IPC bridge with typed ElectronAPI"
```

---

### Task 7: Main process entry — IPC handlers and window setup

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Implement main process entry**

Replace `src/main/index.ts` with:

```typescript
// src/main/index.ts
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { is } from '@electron-toolkit/utils'
import { createPty, writePty, resizePty, killPty, getPtyPid, killAll } from './pty-manager'
import { startMonitoring, stopMonitoring } from './process-monitor'
import { loadPersistedData, savePersistedData } from './persistence'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Start process monitoring
  startMonitoring(mainWindow)
}

// IPC Handlers
ipcMain.on('terminal-create', (_, sessionId, opts) => {
  if (mainWindow) createPty(sessionId, opts, mainWindow)
})

ipcMain.on('terminal-write', (_, sessionId, data) => {
  writePty(sessionId, data)
})

ipcMain.on('terminal-resize', (_, sessionId, cols, rows) => {
  resizePty(sessionId, cols, rows)
})

ipcMain.on('terminal-kill', (_, sessionId) => {
  killPty(sessionId)
})

ipcMain.handle('get-persisted-data', () => {
  return loadPersistedData()
})

ipcMain.handle('terminal-get-cwd', (_, sessionId) => {
  const pid = getPtyPid(sessionId)
  if (!pid) return null
  return new Promise<string | null>((resolve) => {
    execFile('lsof', ['-p', String(pid), '-Fn'], (error, stdout) => {
      if (error) { resolve(null); return }
      const match = stdout.match(/n(\/[^\n]+)/)
      resolve(match ? match[1] : null)
    })
  })
})

// App lifecycle
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  stopMonitoring()
  killAll()
  app.quit()
})

app.on('before-quit', () => {
  stopMonitoring()
  killAll()
})
```

**Step 2: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire up main process with IPC handlers, window creation, and lifecycle"
```

---

### Task 8: Zustand store

**Files:**
- Create: `src/renderer/store/app-store.ts`

**Step 1: Implement the store**

```typescript
// src/renderer/store/app-store.ts
import { create } from 'zustand'
import type { Workspace, TerminalSession, ProcessStatus } from '../../shared/types'

function generateId(): string {
  return crypto.randomUUID()
}

interface AppState {
  workspaces: Record<string, Workspace>
  sessions: Record<string, TerminalSession>
  activeWorkspaceId: string | null
  activeSessionId: string | null

  createWorkspace: (name: string, color: string) => string
  deleteWorkspace: (id: string) => void
  updateWorkspace: (id: string, updates: Partial<Pick<Workspace, 'name' | 'color'>>) => void
  createSession: (workspaceId: string) => string
  deleteSession: (id: string) => void
  setActiveWorkspace: (id: string) => void
  setActiveSession: (id: string) => void
  setProcessStatus: (sessionId: string, status: ProcessStatus) => void
  loadPersistedState: (
    workspaces: Record<string, Workspace>,
    sessions: Record<string, TerminalSession>,
    activeWorkspaceId: string | null,
    activeSessionId: string | null
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: {},
  sessions: {},
  activeWorkspaceId: null,
  activeSessionId: null,

  createWorkspace: (name, color) => {
    const id = generateId()
    const sessionId = generateId()
    const workspace: Workspace = {
      id,
      name,
      color,
      sessionIds: [sessionId],
      createdAt: Date.now()
    }
    const session: TerminalSession = {
      id: sessionId,
      workspaceId: id,
      label: 'Terminal 1',
      processStatus: 'terminal',
      cwd: process.env.HOME || '/',
      shellPath: ''
    }
    set((state) => ({
      workspaces: { ...state.workspaces, [id]: workspace },
      sessions: { ...state.sessions, [sessionId]: session },
      activeWorkspaceId: id,
      activeSessionId: sessionId
    }))
    return id
  },

  deleteWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      const newSessions = { ...state.sessions }
      for (const sid of workspace.sessionIds) {
        delete newSessions[sid]
      }
      const newWorkspaces = { ...state.workspaces }
      delete newWorkspaces[id]
      const remainingIds = Object.keys(newWorkspaces)
      return {
        workspaces: newWorkspaces,
        sessions: newSessions,
        activeWorkspaceId: state.activeWorkspaceId === id
          ? (remainingIds[0] ?? null)
          : state.activeWorkspaceId,
        activeSessionId: state.activeWorkspaceId === id
          ? (newWorkspaces[remainingIds[0]]?.sessionIds[0] ?? null)
          : state.activeSessionId
      }
    })
  },

  updateWorkspace: (id, updates) => {
    set((state) => {
      const workspace = state.workspaces[id]
      if (!workspace) return state
      return {
        workspaces: {
          ...state.workspaces,
          [id]: { ...workspace, ...updates }
        }
      }
    })
  },

  createSession: (workspaceId) => {
    const state = get()
    const workspace = state.workspaces[workspaceId]
    if (!workspace) return ''
    const sessionId = generateId()
    const sessionCount = workspace.sessionIds.length + 1
    const session: TerminalSession = {
      id: sessionId,
      workspaceId,
      label: `Terminal ${sessionCount}`,
      processStatus: 'terminal',
      cwd: process.env.HOME || '/',
      shellPath: ''
    }
    set((state) => ({
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...state.workspaces[workspaceId],
          sessionIds: [...state.workspaces[workspaceId].sessionIds, sessionId]
        }
      },
      sessions: { ...state.sessions, [sessionId]: session },
      activeSessionId: sessionId
    }))
    return sessionId
  },

  deleteSession: (id) => {
    set((state) => {
      const session = state.sessions[id]
      if (!session) return state
      const workspace = state.workspaces[session.workspaceId]
      if (!workspace) return state
      const newSessionIds = workspace.sessionIds.filter((sid) => sid !== id)
      const newSessions = { ...state.sessions }
      delete newSessions[id]
      const newActiveSessionId = state.activeSessionId === id
        ? (newSessionIds[0] ?? null)
        : state.activeSessionId
      return {
        workspaces: {
          ...state.workspaces,
          [session.workspaceId]: { ...workspace, sessionIds: newSessionIds }
        },
        sessions: newSessions,
        activeSessionId: newActiveSessionId
      }
    })
  },

  setActiveWorkspace: (id) => {
    set((state) => {
      const workspace = state.workspaces[id]
      return {
        activeWorkspaceId: id,
        activeSessionId: workspace?.sessionIds[0] ?? null
      }
    })
  },

  setActiveSession: (id) => {
    set({ activeSessionId: id })
  },

  setProcessStatus: (sessionId, status) => {
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, processStatus: status }
        }
      }
    })
  },

  loadPersistedState: (workspaces, sessions, activeWorkspaceId, activeSessionId) => {
    set({ workspaces, sessions, activeWorkspaceId, activeSessionId })
  }
}))
```

**Step 2: Commit**

```bash
git add src/renderer/store/app-store.ts
git commit -m "feat: implement Zustand store for workspace and session state management"
```

---

### Task 9: useTerminal hook

**Files:**
- Create: `src/renderer/hooks/useTerminal.ts`

**Step 1: Implement the hook**

```typescript
// src/renderer/hooks/useTerminal.ts
import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

const api = (window as any).electronAPI as import('../../shared/types').ElectronAPI

export function useTerminal(
  sessionId: string | null,
  containerRef: React.RefObject<HTMLDivElement | null>,
  scrollback?: string
) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
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
      // WebGL not available, fall back to canvas
    }

    fitAddon.fit()

    // Write saved scrollback if restoring
    if (scrollback) {
      term.write(scrollback)
    }

    // Send user input to PTY
    term.onData((data) => {
      api.writeTerminal(sessionId, data)
    })

    // Receive PTY output
    const onData = (sid: string, data: string) => {
      if (sid === sessionId) {
        term.write(data)
      }
    }
    api.onTerminalData(onData)

    // Resize PTY when terminal resizes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      api.resizeTerminal(sessionId, term.cols, term.rows)
    })
    resizeObserver.observe(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Initial resize
    api.resizeTerminal(sessionId, term.cols, term.rows)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  return termRef
}
```

**Step 2: Commit**

```bash
git add src/renderer/hooks/useTerminal.ts
git commit -m "feat: add useTerminal hook for xterm.js lifecycle management"
```

---

### Task 10: useProcessStatus hook

**Files:**
- Create: `src/renderer/hooks/useProcessStatus.ts`

**Step 1: Implement the hook**

```typescript
// src/renderer/hooks/useProcessStatus.ts
import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import type { ProcessStatus } from '../../shared/types'

const api = (window as any).electronAPI as import('../../shared/types').ElectronAPI

export function useProcessStatus(): void {
  const setProcessStatus = useAppStore((s) => s.setProcessStatus)

  useEffect(() => {
    const onProcessChange = (sessionId: string, status: ProcessStatus) => {
      setProcessStatus(sessionId, status)
    }
    api.onProcessChange(onProcessChange)

    return () => {
      // Cleanup handled by removeAllListeners at app level
    }
  }, [setProcessStatus])
}
```

**Step 2: Commit**

```bash
git add src/renderer/hooks/useProcessStatus.ts
git commit -m "feat: add useProcessStatus hook for AI tool detection"
```

---

### Task 11: NavBar + WorkspaceTab components

**Files:**
- Create: `src/renderer/components/NavBar.tsx`
- Create: `src/renderer/components/WorkspaceTab.tsx`
- Create: `src/renderer/components/CreateWorkspaceDialog.tsx`
- Create: `src/renderer/components/ColorPicker.tsx`

**Step 1: Implement ColorPicker**

```typescript
// src/renderer/components/ColorPicker.tsx
import { HexColorPicker } from 'react-colorful'

interface ColorPickerProps {
  color: string
  onChange: (color: string) => void
}

export function ColorPicker({ color, onChange }: ColorPickerProps) {
  return (
    <div className="p-2">
      <HexColorPicker color={color} onChange={onChange} />
    </div>
  )
}
```

**Step 2: Implement CreateWorkspaceDialog**

```typescript
// src/renderer/components/CreateWorkspaceDialog.tsx
import { useState } from 'react'
import { ColorPicker } from './ColorPicker'

interface CreateWorkspaceDialogProps {
  onConfirm: (name: string, color: string) => void
  onCancel: () => void
}

export function CreateWorkspaceDialog({ onConfirm, onCancel }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      onConfirm(name.trim(), color)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-[#1e1e2e] rounded-lg p-6 w-80 shadow-xl"
      >
        <h2 className="text-white text-lg font-semibold mb-4">New Workspace</h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          autoFocus
          className="w-full bg-[#2a2a3e] text-white px-3 py-2 rounded mb-4 outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <ColorPicker color={color} onChange={setColor} />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  )
}
```

**Step 3: Implement WorkspaceTab**

```typescript
// src/renderer/components/WorkspaceTab.tsx
interface WorkspaceTabProps {
  name: string
  color: string
  isActive: boolean
  onClick: () => void
  onDelete: () => void
}

export function WorkspaceTab({ name, color, isActive, onClick, onDelete }: WorkspaceTabProps) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 px-4 py-2 rounded-t-lg transition-colors ${
        isActive ? 'bg-[#1a1a2e] text-white' : 'bg-[#12121e] text-gray-400 hover:text-white'
      }`}
    >
      <span
        className="w-3 h-3 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-sm font-medium truncate max-w-[120px]">{name}</span>
      <span
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="ml-1 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity cursor-pointer"
      >
        ×
      </span>
    </button>
  )
}
```

**Step 4: Implement NavBar**

```typescript
// src/renderer/components/NavBar.tsx
import { useState } from 'react'
import { useAppStore } from '../store/app-store'
import { WorkspaceTab } from './WorkspaceTab'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'

export function NavBar() {
  const [showDialog, setShowDialog] = useState(false)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)

  const sortedWorkspaces = Object.values(workspaces).sort(
    (a, b) => a.createdAt - b.createdAt
  )

  return (
    <>
      <div className="flex items-center bg-[#12121e] px-2 pt-2 gap-1 draggable">
        {sortedWorkspaces.map((ws) => (
          <WorkspaceTab
            key={ws.id}
            name={ws.name}
            color={ws.color}
            isActive={ws.id === activeWorkspaceId}
            onClick={() => setActiveWorkspace(ws.id)}
            onDelete={() => deleteWorkspace(ws.id)}
          />
        ))}
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-2 text-gray-500 hover:text-white transition-colors text-lg"
        >
          +
        </button>
      </div>
      {showDialog && (
        <CreateWorkspaceDialog
          onConfirm={(name, color) => {
            createWorkspace(name, color)
            setShowDialog(false)
          }}
          onCancel={() => setShowDialog(false)}
        />
      )}
    </>
  )
}
```

**Step 5: Commit**

```bash
git add src/renderer/components/NavBar.tsx src/renderer/components/WorkspaceTab.tsx src/renderer/components/CreateWorkspaceDialog.tsx src/renderer/components/ColorPicker.tsx
git commit -m "feat: add NavBar with workspace tabs, color picker, and create dialog"
```

---

### Task 12: Sidebar + SessionItem components

**Files:**
- Create: `src/renderer/components/Sidebar.tsx`
- Create: `src/renderer/components/SessionItem.tsx`

**Step 1: Implement SessionItem**

The icons from hugeicons-react — check the actual export names at import time. Use `Terminal01Icon` for terminal, and for Claude/OpenAI we'll use distinctive icons (e.g., `AiChat02Icon` for Claude, `AiBrain01Icon` for Codex). Adjust import names if they differ.

```typescript
// src/renderer/components/SessionItem.tsx
import type { ProcessStatus } from '../../shared/types'

interface SessionItemProps {
  label: string
  processStatus: ProcessStatus
  isActive: boolean
  accentColor: string
  onClick: () => void
  onDelete: () => void
}

function StatusIcon({ status }: { status: ProcessStatus }) {
  // Using simple SVG icons as fallback; replace with hugeicons imports
  if (status === 'claude') {
    return (
      <span className="text-orange-400 text-lg" title="Claude Code">
        ◈
      </span>
    )
  }
  if (status === 'codex') {
    return (
      <span className="text-green-400 text-lg" title="OpenAI Codex">
        ◇
      </span>
    )
  }
  return (
    <span className="text-gray-400 text-lg" title="Terminal">
      ◼
    </span>
  )
}

export function SessionItem({
  label,
  processStatus,
  isActive,
  accentColor,
  onClick,
  onDelete
}: SessionItemProps) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 w-full px-3 py-2 rounded-md transition-colors text-left ${
        isActive ? 'text-white' : 'text-gray-400 hover:text-white hover:bg-white/5'
      }`}
      style={isActive ? { backgroundColor: accentColor + '20', borderLeft: `3px solid ${accentColor}` } : {}}
    >
      <StatusIcon status={processStatus} />
      <span className="text-sm truncate flex-1">{label}</span>
      <span
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity cursor-pointer"
      >
        ×
      </span>
    </button>
  )
}
```

**Step 2: Implement Sidebar**

```typescript
// src/renderer/components/Sidebar.tsx
import { useAppStore } from '../store/app-store'
import { SessionItem } from './SessionItem'

const api = (window as any).electronAPI as import('../../shared/types').ElectronAPI

export function Sidebar() {
  const workspaces = useAppStore((s) => s.workspaces)
  const sessions = useAppStore((s) => s.sessions)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const createSession = useAppStore((s) => s.createSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)

  const workspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null
  const workspaceSessions = workspace
    ? workspace.sessionIds.map((id) => sessions[id]).filter(Boolean)
    : []

  const handleCreateSession = () => {
    if (!activeWorkspaceId) return
    const sessionId = createSession(activeWorkspaceId)
    if (sessionId) {
      api.createTerminal(sessionId, { cwd: process.env.HOME || '/' })
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    api.killTerminal(sessionId)
    deleteSession(sessionId)
  }

  return (
    <div className="w-56 bg-[#12121e] flex flex-col border-r border-white/5">
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workspaceSessions.map((session) => (
          <SessionItem
            key={session.id}
            label={session.label}
            processStatus={session.processStatus}
            isActive={session.id === activeSessionId}
            accentColor={workspace?.color ?? '#6366f1'}
            onClick={() => setActiveSession(session.id)}
            onDelete={() => handleDeleteSession(session.id)}
          />
        ))}
        {workspaceSessions.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-4">
            No sessions yet
          </p>
        )}
      </div>
      <div className="p-2 border-t border-white/5">
        <button
          onClick={handleCreateSession}
          disabled={!activeWorkspaceId}
          className="w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-50"
        >
          + New Session
        </button>
      </div>
    </div>
  )
}
```

**Step 3: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/components/SessionItem.tsx
git commit -m "feat: add Sidebar with session list and dynamic process status icons"
```

---

### Task 13: TerminalArea + TerminalInstance components

**Files:**
- Create: `src/renderer/components/TerminalArea.tsx`
- Create: `src/renderer/components/TerminalInstance.tsx`

**Step 1: Implement TerminalInstance**

```typescript
// src/renderer/components/TerminalInstance.tsx
import { useRef } from 'react'
import { useTerminal } from '../hooks/useTerminal'

interface TerminalInstanceProps {
  sessionId: string
  scrollback?: string
}

export function TerminalInstance({ sessionId, scrollback }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  useTerminal(sessionId, containerRef, scrollback)

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
    />
  )
}
```

**Step 2: Implement TerminalArea**

```typescript
// src/renderer/components/TerminalArea.tsx
import { useAppStore } from '../store/app-store'
import { TerminalInstance } from './TerminalInstance'

export function TerminalArea() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)

  if (!activeWorkspaceId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1a1a2e] text-gray-500">
        <p>Create a workspace to get started</p>
      </div>
    )
  }

  if (!activeSessionId) {
    const workspace = workspaces[activeWorkspaceId]
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1a1a2e] text-gray-500">
        <p>Create a session in "{workspace?.name}"</p>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-[#1a1a2e] p-1">
      <TerminalInstance sessionId={activeSessionId} />
    </div>
  )
}
```

**Step 3: Commit**

```bash
git add src/renderer/components/TerminalArea.tsx src/renderer/components/TerminalInstance.tsx
git commit -m "feat: add TerminalArea and TerminalInstance with xterm.js rendering"
```

---

### Task 14: App.tsx — assemble the layout

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Implement App layout**

```typescript
// src/renderer/App.tsx
import { useEffect } from 'react'
import { NavBar } from './components/NavBar'
import { Sidebar } from './components/Sidebar'
import { TerminalArea } from './components/TerminalArea'
import { useProcessStatus } from './hooks/useProcessStatus'
import { useAppStore } from './store/app-store'
import type { PersistedData } from '../shared/types'

const api = (window as any).electronAPI as import('../shared/types').ElectronAPI

export function App() {
  const loadPersistedState = useAppStore((s) => s.loadPersistedState)
  useProcessStatus()

  useEffect(() => {
    // Load persisted data on startup
    api.getPersistedData().then((data: PersistedData | null) => {
      if (data && Object.keys(data.workspaces).length > 0) {
        // Strip scrollback from session data for Zustand (it's only for xterm restore)
        const sessions: Record<string, any> = {}
        for (const [id, session] of Object.entries(data.sessions)) {
          const { scrollback, env, ...rest } = session
          sessions[id] = rest
        }
        loadPersistedState(
          data.workspaces,
          sessions,
          data.activeWorkspaceId,
          data.activeSessionId
        )
        // Recreate PTYs for each session
        for (const [id, session] of Object.entries(data.sessions)) {
          api.createTerminal(id, { cwd: session.cwd })
        }
      }
    })

    // Handle terminal exits
    api.onTerminalExit((sessionId: string) => {
      useAppStore.getState().deleteSession(sessionId)
    })

    return () => {
      api.removeAllListeners()
    }
  }, [])

  return (
    <div className="h-screen flex flex-col bg-[#0e0e1a] text-white overflow-hidden">
      <NavBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <TerminalArea />
      </div>
    </div>
  )
}
```

**Step 2: Update main.tsx entry**

Ensure `src/renderer/main.tsx` renders `<App />` and imports `index.css`:

```typescript
// src/renderer/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

**Step 3: Commit**

```bash
git add src/renderer/App.tsx src/renderer/main.tsx
git commit -m "feat: assemble full app layout with NavBar, Sidebar, and TerminalArea"
```

---

### Task 15: Integrate hugeicons for session status icons

**Files:**
- Modify: `src/renderer/components/SessionItem.tsx`

**Step 1: Find the correct hugeicons exports**

```bash
cd /Users/txp/Pessoal/orchestra
grep -r "Terminal" node_modules/hugeicons-react/dist/esm/icons/ | head -5
```

Find the actual icon names. Expected: something like `Terminal01Icon`. For Claude use a brain/AI icon, for Codex use another. Check available icons with:

```bash
ls node_modules/hugeicons-react/dist/esm/icons/ | grep -i "terminal\|brain\|ai\|robot\|code" | head -20
```

**Step 2: Update SessionItem with real hugeicons**

Replace the `StatusIcon` component in `SessionItem.tsx` with the actual hugeicons imports. Example (adjust names based on step 1):

```typescript
import { TerminalIcon } from 'hugeicons-react'
// Claude and Codex icons — pick appropriate ones from hugeicons

function StatusIcon({ status }: { status: ProcessStatus }) {
  const iconClass = "w-5 h-5"
  if (status === 'claude') {
    return <span className={`${iconClass} text-orange-400`} title="Claude Code">◈</span>
  }
  if (status === 'codex') {
    return <span className={`${iconClass} text-green-400`} title="OpenAI Codex">◇</span>
  }
  return <TerminalIcon className={iconClass + " text-gray-400"} />
}
```

Note: For Claude and Codex we may need custom SVG icons since hugeicons likely doesn't have brand-specific icons. Create small inline SVGs or use recognizable generic icons from hugeicons.

**Step 3: Commit**

```bash
git add src/renderer/components/SessionItem.tsx
git commit -m "feat: integrate hugeicons for terminal session status icons"
```

---

### Task 16: Persistence auto-save middleware

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add debounced auto-save**

Add a `useEffect` in `App.tsx` that subscribes to Zustand store changes and saves via IPC. Since electron-store is in the main process, we need an IPC call. Add a new IPC handler:

In `src/main/index.ts`, add:

```typescript
ipcMain.on('save-state', (_, data) => {
  saveWorkspaces(data.workspaces, data.sessions, data.activeWorkspaceId, data.activeSessionId)
})
```

In `src/preload/index.ts`, add to the api object:

```typescript
saveState: (data: { workspaces: any; sessions: any; activeWorkspaceId: string | null; activeSessionId: string | null }) => {
  ipcRenderer.send('save-state', data)
}
```

In `src/shared/types.ts`, add to `ElectronAPI`:

```typescript
saveState: (data: { workspaces: Record<string, Workspace>; sessions: Record<string, TerminalSession>; activeWorkspaceId: string | null; activeSessionId: string | null }) => void
```

In `App.tsx`, add auto-save effect:

```typescript
useEffect(() => {
  let timeout: ReturnType<typeof setTimeout>
  const unsub = useAppStore.subscribe((state) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      api.saveState({
        workspaces: state.workspaces,
        sessions: state.sessions,
        activeWorkspaceId: state.activeWorkspaceId,
        activeSessionId: state.activeSessionId
      })
    }, 1000)
  })
  return () => {
    clearTimeout(timeout)
    unsub()
  }
}, [])
```

**Step 2: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/shared/types.ts src/renderer/App.tsx
git commit -m "feat: add debounced auto-save of workspace/session state"
```

---

### Task 17: Verify full integration — manual smoke test

**Step 1: Run the app**

```bash
cd /Users/txp/Pessoal/orchestra
bun run dev
```

**Step 2: Test the following manually**

1. App opens with empty state
2. Click `+` in navbar → create workspace dialog appears
3. Enter name, pick a color, hit Create
4. Workspace tab appears with colored dot, sidebar shows "Terminal 1"
5. Terminal renders in center area with working shell
6. Type commands, verify shell works
7. Click `+ New Session` in sidebar → second terminal appears
8. Switch between sessions via sidebar
9. Create a second workspace, verify it switches correctly
10. Close and reopen the app → workspaces and sessions should restore
11. Run `claude` in a terminal → sidebar icon should change within ~2s
12. Exit claude → icon reverts to terminal

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: address integration issues from smoke testing"
```
