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

// Track whether Electron's Notification API actually delivers.
// Once we know it works (or doesn't), skip the probe on future calls.
let electronNotificationsWork: boolean | null = null

/**
 * macOS fallback: use osascript to post a notification.
 * Works regardless of bundle ID, signing, or notification permissions.
 */
function showOsascriptNotification(title: string, body: string): void {
  const escaped = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `display notification "${escaped(body)}" with title "${escaped(title)}" sound name "default"`
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

  const notification = new Notification({ title, body, silent: false })
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

  const message = `${summary} is ready`

  // Summarize the agent's last response for the description
  let description: string | undefined
  if (lastResponse) {
    try {
      description = await summarizeResponse(lastResponse)
    } catch {
      // Silently skip description if summarization fails
    }
  }

  // Always send in-app toast (visible now if focused, visible on return if not)
  mainWindow.webContents.send('idle-notification', {
    sessionId,
    summary: message,
    description,
    agentType
  })

  console.log('[idle-notifier] session=%s focused=%s', sessionId, focused)

  // When app is not focused, get the user's attention
  if (!focused) {
    app.dock?.bounce('informational')

    const body = description ? `${message}\n${description}` : message
    showNativeNotification('Orchestra', body, sessionId)
  }
}
