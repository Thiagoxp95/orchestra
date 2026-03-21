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
import {
  detectRequiresUserInput,
  normalizePromptText,
  summarizePrompt,
} from './prompt-summarizer'

/** Prompts shorter than this are shown verbatim in notifications. */
const PROMPT_SHORT_THRESHOLD = 30

/** Strip code blocks and markdown noise before sending to the summarizer LLM. */
function cleanForSummarization(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')    // remove fenced code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))  // unwrap inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // strip bold
    .replace(/^#+\s+/gm, '')           // strip heading markers
    .replace(/\n+/g, ' ')
    .trim()
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text

  const clipped = text.slice(0, maxLength + 1)
  const lastSpace = clipped.lastIndexOf(' ')
  const boundary = lastSpace >= Math.floor(maxLength * 0.6) ? lastSpace : maxLength
  return `${clipped.slice(0, boundary).trimEnd()}…`
}

/** Detect garbled text where spaces were lost (e.g. "Keepone+NewExpensebutton").
 *  If the average word length is suspiciously high, the text is unreadable. */
function looksGarbled(text: string): boolean {
  const words = text.split(/[\s\-—]+/).filter((w) => w.length > 0)
  if (words.length === 0) return false
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / words.length
  return avgLen > 18
}

let mainWindow: BrowserWindow | null = null
let activeSessionId: string | null = null
let pendingCriticalBounceId: number | null = null
/** Per-session generation counter — used to cancel stale notifications when a
 *  new idle transition fires while a previous one is still being summarized. */
const notifyGeneration = new Map<string, number>()

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
  lastResponse?: string,
  lastUserPrompt?: string
): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return

  // Bump the generation counter. If another idle transition fires for this
  // session while we're still summarizing, the stale call will bail out.
  const gen = (notifyGeneration.get(sessionId) ?? 0) + 1
  notifyGeneration.set(sessionId, gen)

  const focused = mainWindow.isFocused()
  const isLookingAtSession = focused && sessionId === activeSessionId

  // Derive title from what the USER asked (the prompt), never from the agent's
  // response. The notification tells you WHAT task finished. We only use the
  // response to detect whether the agent is asking a follow-up question.
  const defaultLabel = agentLabel(agentType)
  let summary = defaultLabel
  let requiresUserInput = false

  // Detect requiresUserInput from the agent's response regardless of prompt availability
  if (lastResponse) {
    requiresUserInput = detectRequiresUserInput(lastResponse)
  }

  if (lastUserPrompt) {
    const cleanedPrompt = normalizePromptText(cleanForSummarization(lastUserPrompt) || lastUserPrompt)

    // Short prompts are shown verbatim; long ones get summarized
    if (cleanedPrompt.length <= PROMPT_SHORT_THRESHOLD) {
      summary = cleanedPrompt || defaultLabel
    } else {
      try {
        summary = await summarizePrompt(cleanedPrompt || lastUserPrompt)
        if (notifyGeneration.get(sessionId) !== gen) return // stale
      } catch {
        summary = truncateText(cleanedPrompt, 60) || defaultLabel
      }
    }
  }
  // When no user prompt is available, keep the generic agent label (e.g. "Claude")
  // — never show the agent's raw response in the notification.

  // Final staleness check before emitting
  if (notifyGeneration.get(sessionId) !== gen) return

  const heading = getNotificationHeading(agentType, requiresUserInput)
  const shouldShowToast = requiresUserInput || !isLookingAtSession

  // Always send in-app notification so the renderer can set needsUserInput state,
  // even if the user is currently looking at this session.
  mainWindow.webContents.send('idle-notification', {
    sessionId,
    title: summary,
    agentType,
    requiresUserInput,
    showToast: shouldShowToast,
    // In dev builds, include the raw last response for debugging
    ...(!app.isPackaged && lastResponse ? { debugLastResponse: lastResponse } : {})
  })

  console.log(
    '[idle-notifier] session=%s focused=%s isLookingAtSession=%s requiresUserInput=%s',
    sessionId,
    focused,
    isLookingAtSession,
    requiresUserInput
  )

  // When app is not focused, get the user's attention
  if (!focused) {
    if (requiresUserInput) {
      requestQuestionBounce()
    } else {
      app.dock?.bounce('informational')
    }

    const notificationBody = looksGarbled(summary) ? `${defaultLabel} finished working` : summary
    showNativeNotification(heading, notificationBody, sessionId)
  }
}
