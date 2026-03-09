# Idle Notification Feature Design

## Date: 2026-03-09

## Overview

Notify users when Claude Code or Codex sessions transition from working to idle, but only when the user is viewing a different session. The notification shows a 3-4 word summary of the user's prompt followed by "is ready".

## Trigger

When `claude-work-state` or `codex-work-state` transitions from `'working'` → `'idle'`, **and** the finished session is not the currently active session.

## Notification Content

**"{summary} is ready"** — e.g., "Deploy auth fix is ready"

The summary comes from the existing `prompt-summarizer.ts` (Convex backend). Last prompt is fetched from `getPromptHistory(sessionId)` and summarized. If summarization fails, fall back to the session label (e.g., "Session 3 is ready").

## Delivery

- **App focused** → In-app toast, bottom-right corner, auto-dismisses after 5s with fade-out. Clicking navigates to the session.
- **App not focused** → macOS native `Notification` (Electron's `Notification` API). Clicking brings app to focus and navigates to the session.

## Flow

1. Main process detects working→idle transition (already exists in `emitWorkState`)
2. Main process checks: is this the active session? (query renderer via IPC or track in main)
3. If not active → fetch last prompt → summarize → determine app focus (`BrowserWindow.isFocused()`)
4. Focused: send IPC `'idle-notification'` to renderer → toast component renders
5. Not focused: create Electron `Notification`, on click → `mainWindow.show()` + send IPC to switch session

## Toast Component

- Fixed bottom-right, `z-50`, dark theme matching app (`#1a1a2e` bg)
- Shows session icon/color dot + "{summary} is ready"
- Fade-in on appear, fade-out after 5s
- Click → `setActiveSession(sessionId)` + dismiss
- Stack multiple toasts if several finish close together (newest on bottom)

## Changes Required

| File | Change |
|------|--------|
| `claude-session-watcher.ts` | On working→idle, call notification logic |
| `codex-session-watcher.ts` | Same |
| New: `src/main/idle-notifier.ts` | Orchestrates: active session check, summarize, dispatch toast or native notification |
| `preload/index.ts` | Expose `onIdleNotification` IPC listener |
| `shared/types.ts` | Add `IdleNotification` type |
| New: `src/renderer/src/components/Toast.tsx` | Toast UI component |
| `App.tsx` or `useAgentResponses.ts` | Listen for `idle-notification` IPC, render toast, handle click-to-navigate |
| `app-store.ts` | Track active session ID accessible from main (or add IPC) |
