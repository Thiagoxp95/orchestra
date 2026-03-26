# Interruption Mode

## Overview

Per-workspace toggle that spawns a minimal, always-on-top popup window containing the terminal session whenever an agent (Claude/Codex) needs user input. The popup appears regardless of whether Orchestra is focused, letting the user respond immediately. It disappears when the agent transitions back to a working state.

## Data Model

### Workspace type additions

```ts
interface Workspace {
  // ...existing fields...
  interruptionMode?: boolean                        // default: false
  interruptionPosition?: InterruptionPosition       // default: 'bottom-right'
}

type InterruptionPosition = 'bottom-left' | 'bottom-right' | { x: number; y: number }
```

- `interruptionMode` is optional — absent or `false` means disabled. Existing workspaces need no migration.
- `interruptionPosition` is optional — defaults to `'bottom-right'` when absent.

### Store changes

The `updateWorkspace` action must accept `interruptionMode` and `interruptionPosition` in its partial update type.

## Trigger

Hooks into the existing "needs user input" detection — the same signal that drives the yellow indicator, bouncy icon, and Reply badge. Specifically:

- **Claude**: `PermissionRequest` hook events, and idle prompt detection when the watcher determines the agent is asking a question (the existing `sessionNeedsUserInput` signal).
- **Codex**: `waitingUserInput` / `waitingApproval` states, and `UserInputRequest` hook events.

No new detection logic is needed. The main process already knows when a session needs input via the `AgentSessionRegistry` and the watcher state machines.

## Popup Window

### Creation

A new Electron `BrowserWindow` per session that needs input:

```ts
const popup = new BrowserWindow({
  width: 800,
  height: 400,
  frame: false,                    // frameless — custom header in renderer
  alwaysOnTop: true,               // floats above all apps
  resizable: false,
  skipTaskbar: true,               // don't clutter taskbar/dock
  show: false,                     // show after content is ready
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false
  }
})
```

Position is computed from the workspace's `interruptionPosition` setting and the primary display's work area.

### Content

The popup loads a dedicated route/entry point that renders:

1. **Header** (~32px): workspace color dot + workspace name + session label + close button (×)
2. **Body** (remaining height): xterm.js terminal attached to the session via the same daemon stream used by the main window

The popup renderer reuses the existing terminal attachment mechanism — `createTerminal` / `onTerminalData` / `onTerminalSnapshot` — connecting to the same daemon session. Both the main window and the popup can be attached simultaneously since the daemon supports multiple stream clients per session.

### Focus behavior

- `popup.show()` + `popup.focus()` to steal focus from whatever app is in front
- The terminal inside auto-focuses so the user can start typing immediately

## Dismissal

The popup closes when the agent transitions back to a "working" state — meaning it received the input and started processing. This uses the same state detection that triggers the yellow indicator / Reply badge, in reverse.

- Main process watches for the agent state transition (via `AgentSessionRegistry` or watcher callbacks)
- Calls `popup.close()` when the session is no longer in a "needs input" state

If the user closes the popup manually (× button or Escape), the session continues normally in the main window. No input is lost — the terminal session is not tied to the popup's lifecycle.

If the user responds from the main window instead of the popup, the agent still transitions to "working" and the popup closes naturally.

## Multiple Popups

When multiple sessions need input simultaneously, popups stack with an offset. Each new popup is offset by ~30px from the previous in both x and y, so all are visible and the user can click on any to bring it to front and respond.

The main process tracks active popup windows in a `Map<sessionId, BrowserWindow>`. When computing position for a new popup, it accounts for existing active popups to apply the stacking offset.

## Position Calculation

```ts
function getPopupPosition(
  position: InterruptionPosition,
  workArea: Electron.Rectangle,
  stackIndex: number
): { x: number; y: number } {
  const OFFSET = 30
  const WIDTH = 800
  const HEIGHT = 400
  const MARGIN = 16

  let x: number, y: number

  if (typeof position === 'object') {
    x = position.x
    y = position.y
  } else if (position === 'bottom-left') {
    x = workArea.x + MARGIN
    y = workArea.y + workArea.height - HEIGHT - MARGIN
  } else {
    // bottom-right (default)
    x = workArea.x + workArea.width - WIDTH - MARGIN
    y = workArea.y + workArea.height - HEIGHT - MARGIN
  }

  // Stack offset
  x += stackIndex * OFFSET
  y -= stackIndex * OFFSET

  return { x, y }
}
```

## Workspace Settings UI

The interruption mode toggle and position selector live in the workspace settings panel, alongside existing settings like notification sounds and view mode.

### Controls

- **Toggle**: "Interruption Mode" — on/off switch
- **Position dropdown** (visible when toggle is on): "Bottom Left", "Bottom Right", "Custom"
- **Custom position inputs** (visible when "Custom" selected): x/y number inputs

## Architecture — New Files

| File | Purpose |
|------|---------|
| `src/main/interruption-popup.ts` | Popup window lifecycle: create, position, track, close |
| `src/renderer/src/popup/PopupTerminal.tsx` | Popup renderer: header + xterm.js terminal |
| `src/renderer/src/popup/popup-entry.tsx` | Entry point for popup window (loaded by popup HTML) |
| `popup.html` | HTML shell for popup BrowserWindow |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `interruptionMode`, `interruptionPosition`, `InterruptionPosition` |
| `src/main/index.ts` | Wire up interruption popup manager to agent state changes |
| `src/main/agent-session-authority.ts` or watchers | Emit events that the popup manager listens to |
| `src/renderer/src/store/app-store.ts` | Expose new workspace fields in update actions |
| `src/renderer/src/components/WorkspaceSettings.tsx` (or equivalent) | Add interruption mode controls |
| `src/preload/index.ts` | Expose session info for popup renderer (session ID, workspace metadata passed via window params) |
| `electron.vite.config.ts` | Add popup HTML as additional renderer entry |

## Data Flow

1. Agent state transitions to "needs input" (existing detection)
2. `AgentSessionRegistry` or watcher emits the state change
3. `InterruptionPopupManager` in main process receives the event
4. Looks up the session's workspace → checks `interruptionMode === true`
5. Creates a `BrowserWindow` with computed position, loads `popup.html?sessionId=xxx`
6. Popup renderer reads session ID from URL params, attaches xterm.js to the daemon session
7. User types response, presses Enter
8. Agent transitions to "working" state
9. Main process detects the transition → calls `popup.close()`
10. Popup window is removed from the active map

## Edge Cases

- **User responds from main window**: popup closes naturally when agent goes back to working
- **User closes popup manually**: session continues in main window, no input lost
- **Session is killed while popup is open**: popup closes (listen for session exit events)
- **Workspace interruption mode toggled off while popups are open**: close all active popups for that workspace
- **Multiple displays**: use `screen.getDisplayNearestPoint()` or primary display for positioning
- **App quit**: all popup windows close with the app (standard Electron behavior)
