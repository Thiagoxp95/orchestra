# Orchestra — Terminal Orchestration App Design

## Overview

Orchestra is an Electron desktop application for managing multiple terminal sessions organized into color-coded workspaces. It detects when AI coding tools (Claude Code, OpenAI Codex) are running in a session and updates the sidebar icon accordingly. Sessions persist across app restarts with scrollback buffer restoration.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron (latest) |
| Build tooling | electron-vite |
| Package manager | bun |
| UI framework | React 19 |
| Styling | Tailwind CSS |
| Icons | hugeicons-react |
| Terminal emulator | xterm.js + @xterm/addon-fit + @xterm/addon-webgl |
| PTY backend | node-pty |
| State management | Zustand |
| Persistence | electron-store |
| Process monitoring | Custom polling via `pgrep -lP <pid>` |
| Color picker | react-colorful |

## Architecture

```
Main Process
├── PTY Manager (node-pty) — spawns/kills/resizes PTYs
├── Process Monitor — polls child processes every ~2s to detect claude/codex
└── Persistence (electron-store) — saves/loads workspace and session state

IPC Bridge (preload.ts) — typed API between main and renderer

Renderer Process
├── React App (Vite + Tailwind)
├── Zustand Store — workspace/session state
├── xterm.js instances — terminal rendering
└── UI Components — NavBar, Sidebar, TerminalArea
```

## UI Layout

- **NavBar (top):** Horizontal workspace tabs with colored dots. `+` button to create a new workspace (name + full color picker). Right-click for rename/delete/change color.
- **Sidebar (left):** Vertical list of terminal sessions for the active workspace. Each entry has a dynamic icon (terminal/claude/codex) + label. `+` button to create new session. Hover shows `x` to delete.
- **TerminalArea (center):** Renders the xterm.js instance for the selected session. Clicking a sidebar entry switches the visible terminal.

### Interaction details

- Clicking a workspace tab switches the sidebar to that workspace's sessions
- Active session highlighted with workspace color as accent
- Creating a new workspace auto-creates one default terminal session
- Deleting the last session keeps the workspace, shows empty state with prompt

## Data Model

### Zustand Store

```typescript
interface Workspace {
  id: string;
  name: string;
  color: string; // hex from color picker
  sessionIds: string[];
  createdAt: number;
}

interface TerminalSession {
  id: string;
  workspaceId: string;
  label: string; // defaults to "Terminal 1", etc.
  processStatus: 'terminal' | 'claude' | 'codex';
  cwd: string;
  shellPath: string;
}

interface AppState {
  workspaces: Record<string, Workspace>;
  sessions: Record<string, TerminalSession>;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  // Actions: createWorkspace, deleteWorkspace, updateWorkspace,
  //          createSession, deleteSession, setActiveWorkspace,
  //          setActiveSession, setProcessStatus
}
```

### Persisted Data

```typescript
interface PersistedData {
  workspaces: Record<string, Workspace>;
  sessions: Record<string, TerminalSession & {
    scrollback: string;
    env: Record<string, string>;
  }>;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
}
```

## Persistence Strategy

- **On change:** Zustand middleware auto-saves workspace/session metadata to electron-store (debounced ~1s)
- **On quit:** Capture each terminal's scrollback buffer and current cwd via IPC, write final state
- **On launch:** Load persisted data, recreate Zustand state, spawn new PTYs in saved cwds, pre-populate xterm.js with saved scrollback

This gives a tmux-like "back where you were" experience. Running processes are not preserved (they die on quit), but the visual state is fully restored.

## IPC API

```typescript
interface ElectronAPI {
  createTerminal: (sessionId: string, opts: { cwd: string; shell?: string }) => void;
  killTerminal: (sessionId: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  writeTerminal: (sessionId: string, data: string) => void;
  onTerminalData: (callback: (sessionId: string, data: string) => void) => void;
  onProcessChange: (callback: (sessionId: string, status: 'terminal' | 'claude' | 'codex') => void) => void;
  onTerminalExit: (callback: (sessionId: string) => void) => void;
  captureScrollback: (sessionId: string) => Promise<string>;
  getCwd: (sessionId: string) => Promise<string>;
  removeAllListeners: () => void;
}
```

Security: `contextIsolation: true`, `nodeIntegration: false`.

## Process Detection

- Poll every ~2s using `pgrep -lP <pid>` for each PTY's shell pid
- Match child process names against `claude` and `codex`
- Emit IPC event on status change; renderer updates Zustand `processStatus`
- Only poll sessions in the active workspace to minimize overhead
- When matched process exits, icon reverts to terminal

## Project Structure

```
orchestra/
├── electron.vite.config.ts
├── package.json
├── tailwind.config.ts
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── pty-manager.ts
│   │   ├── process-monitor.ts
│   │   └── persistence.ts
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── store/
│       │   └── app-store.ts
│       ├── components/
│       │   ├── NavBar.tsx
│       │   ├── WorkspaceTab.tsx
│       │   ├── Sidebar.tsx
│       │   ├── SessionItem.tsx
│       │   ├── TerminalArea.tsx
│       │   ├── TerminalInstance.tsx
│       │   ├── ColorPicker.tsx
│       │   └── CreateWorkspaceDialog.tsx
│       └── hooks/
│           ├── useTerminal.ts
│           └── useProcessStatus.ts
```
