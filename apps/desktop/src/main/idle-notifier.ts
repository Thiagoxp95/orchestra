// src/main/idle-notifier.ts
// Orchestrates idle notifications: checks active session, summarizes prompt,
// dispatches in-app toast (focused) or native macOS notification (not focused).
//
// Electron's Notification API on macOS silently fails when the app isn't
// properly code-signed or hasn't been granted notification permissions.
// We try Electron first and, if the `show` event doesn't fire within 1.5s,
// fall back to osascript which always works.

import { app, BrowserWindow, Notification } from 'electron'
import { execFile } from 'node:child_process'
import { summarizePrompt, summarizeResponse } from './prompt-summarizer'
import { getDaemonClient } from './daemon-client'

let mainWindow: BrowserWindow | null = null
let activeSessionId: string | null = null
let pendingCriticalBounceId: number | null = null

// Track whether Electron's Notification API actually delivers.
// Once we know it works (or doesn't), skip the probe on future calls.
let electronNotificationsWork: boolean | null = null

function agentLabel(agentType: 'claude' | 'codex'): string {
  return agentType === 'claude' ? 'Claude' : 'Codex'
}

function getNotificationHeading(agentType: 'claude' | 'codex', requiresUserInput: boolean): string {
  return requiresUserInput
    ? `${agentLabel(agentType)} needs your input`
    : `${agentLabel(agentType)} is ready`
}

function requestQuestionBounce(): void {
  if (process.platform !== 'darwin') return
  const dock = app.dock
  if (!dock) return

  if (pendingCriticalBounceId !== null) {
    dock.cancelBounce(pendingCriticalBounceId)
  }

  pendingCriticalBounceId = dock.bounce('critical')
}

function clearQuestionBounce(): void {
  if (process.platform !== 'darwin') return
  const dock = app.dock
  if (!dock || pendingCriticalBounceId === null) return

  dock.cancelBounce(pendingCriticalBounceId)
  pendingCriticalBounceId = null
}

/**
 * macOS fallback: use osascript to post a notification.
 * Works regardless of bundle ID, signing, or notification permissions.
 */
function showOsascriptNotification(title: string, body: string): void {
  const escaped = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `display notification "${escaped(body)}" with title "${escaped(title)}"`
  execFile('osascript', ['-e', script], (err) => {
    if (err) {
      console.error('[idle-notifier] osascript fallback failed:', err.message)
    }
  })
}

/**
 * Show a native notification with automatic fallback.
 * On macOS, if Electron's API silently drops the notification we fall back to osascript.
 */
function showNativeNotification(
  title: string,
  body: string,
  sessionId: string
): void {
  // Fast path: we already know Electron notifications don't work on this machine
  if (process.platform === 'darwin' && electronNotificationsWork === false) {
    showOsascriptNotification(title, body)
    return
  }

  if (!Notification.isSupported()) {
    if (process.platform === 'darwin') {
      showOsascriptNotification(title, body)
    }
    return
  }

  const notification = new Notification({ title, body, silent: true })
  let delivered = false

  notification.on('show', () => {
    delivered = true
    if (electronNotificationsWork === null) {
      electronNotificationsWork = true
      console.log('[idle-notifier] Electron notifications confirmed working')
    }
  })

  notification.on('failed', (_event, error) => {
    delivered = true // prevent duplicate from timeout
    console.error('[idle-notifier] Electron notification failed:', error)
    if (process.platform === 'darwin') {
      electronNotificationsWork = false
      showOsascriptNotification(title, body)
    }
  })

  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('navigate-to-session', sessionId)
    }
  })

  notification.show()

  // If Electron silently drops the notification (no `show` or `failed` event),
  // fall back after a short timeout.  Only probe once.
  if (process.platform === 'darwin' && electronNotificationsWork === null) {
    setTimeout(() => {
      if (!delivered) {
        console.warn('[idle-notifier] Electron notification silently dropped — switching to osascript')
        electronNotificationsWork = false
        showOsascriptNotification(title, body)
      }
    }, 1500)
  }
}

export function initIdleNotifier(window: BrowserWindow): void {
  mainWindow = window
  mainWindow.on('focus', () => {
    clearQuestionBounce()
  })
  console.log('[idle-notifier] Initialized. Notification.isSupported()=%s', Notification.isSupported())
}

export function setActiveSessionId(sessionId: string | null): void {
  activeSessionId = sessionId
}

export async function notifyIdleTransition(
  sessionId: string,
  agentType: 'claude' | 'codex',
  lastResponse?: string
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const focused = mainWindow.isFocused()

  // Skip notification only if the user is actively looking at this session
  if (focused && sessionId === activeSessionId) return

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

  // Summarize the agent's last response for the description and input-needed state.
  let description: string | undefined
  let requiresUserInput = false
  if (lastResponse) {
    try {
      const result = await summarizeResponse(lastResponse)
      description = result.summary
      requiresUserInput = result.requiresUserInput
    } catch {
      // Silently skip description if summarization fails
    }
  }

  const heading = getNotificationHeading(agentType, requiresUserInput)

  // Always send in-app toast (visible now if focused, visible on return if not)
  mainWindow.webContents.send('idle-notification', {
    sessionId,
    title: summary,
    description,
    agentType,
    requiresUserInput
  })

  console.log(
    '[idle-notifier] session=%s focused=%s requiresUserInput=%s',
    sessionId,
    focused,
    requiresUserInput
  )

  // When app is not focused, get the user's attention
  if (!focused) {
    if (requiresUserInput) {
      requestQuestionBounce()
    } else {
      app.dock?.bounce('informational')
    }

    const body = description ? `${summary}\n${description}` : summary
    showNativeNotification(heading, body, sessionId)
  }
}
