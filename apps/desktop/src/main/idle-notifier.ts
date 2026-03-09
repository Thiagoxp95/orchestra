// src/main/idle-notifier.ts
// Orchestrates idle notifications: checks active session, summarizes prompt,
// dispatches in-app toast (focused) or native macOS notification (not focused).

import { app, BrowserWindow, Notification } from 'electron'
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

  // Always send in-app toast (visible now if focused, visible on return if not)
  mainWindow.webContents.send('idle-notification', {
    sessionId,
    summary: message,
    agentType
  })

  // When app is not focused, get the user's attention
  if (!mainWindow.isFocused()) {
    // Bounce the dock icon (works in dev mode without notification permissions)
    app.dock?.bounce('informational')

    // Native macOS notification (works in packaged builds with proper bundle ID)
    if (Notification.isSupported()) {
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
}
