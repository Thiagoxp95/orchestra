// src/main/idle-notifier.ts
// Orchestrates idle notifications: checks active session, summarizes prompt,
// dispatches in-app toast (focused) or native macOS notification (not focused).
//
// Uses Electron's Notification API exclusively. On macOS the `show` event may
// not fire reliably, but the notification IS delivered when permissions are
// granted in System Settings → Notifications. The dock bounce and in-app toast
// provide reliable attention mechanisms regardless.

import { app, BrowserWindow, Notification } from 'electron'
import {
  detectRequiresUserInput,
  normalizePromptText,
  summarizePrompt,
} from './prompt-summarizer'
import { getTerminalBufferText } from './terminal-output-buffer'

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

/**
 * Scan the terminal buffer for a question directed at the user, skipping
 * Claude TUI elements (task list, status bar, prompt character).
 *
 * Walks backward through lines and stops at the first "real" content line
 * (the tail of Claude's actual response). This avoids false positives from
 * arbitrary text deeper in the buffer.
 */
function detectQuestionInTerminalBuffer(sessionId: string): boolean {
  const raw = getTerminalBufferText(sessionId).slice(-2000)
  if (!raw) return false

  const lines = raw.split('\n')
  let contentLinesChecked = 0
  const MAX_CONTENT_LINES = 5

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
    const line = lines[i].trim()
    if (!line || line.length < 3) continue

    // Skip prompt characters
    if (/^[❯❮$%>→]\s*$/.test(line)) continue

    // Skip status bar lines
    const lower = line.toLowerCase()
    if (lower.includes('shift+tab to cycle')) continue
    if (lower.includes('bypass permissions')) continue
    if (lower.includes('run /init')) continue
    if (lower.includes('no recent activity')) continue

    // Skip task list items (✓/□/■/●/⏺ followed by text, or "N tasks (...)")
    if (/^[✓✗□■●⏺☐☑⬜✅❌]\s/.test(line)) continue
    if (/^\d+\s+tasks?\s*\(/.test(line)) continue

    // Skip box-drawing / separator lines
    if (/^[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬\-=+|_\s.…]+$/.test(line)) continue

    // Skip lines without any real word
    if (!/[a-zA-Z]{2,}/.test(line)) continue

    // This is a real content line — check for question indicators
    if (detectRequiresUserInput(line)) return true

    contentLinesChecked++
    if (contentLinesChecked >= MAX_CONTENT_LINES) break
  }

  return false
}

let mainWindow: BrowserWindow | null = null
let activeSessionId: string | null = null
let pendingCriticalBounceId: number | null = null
/** Per-session generation counter — used to cancel stale notifications when a
 *  new idle transition fires while a previous one is still being summarized. */
const notifyGeneration = new Map<string, number>()

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
 * Show a native notification via Electron's Notification API.
 *
 * On macOS the `show` event may not fire reliably (Electron/macOS version
 * quirk), but the notification IS delivered when permissions are enabled in
 * System Settings → Notifications. We intentionally do NOT fall back to
 * osascript because it attributes notifications to "Script Editor" and
 * clicking them activates Script Editor instead of Orchestra.
 *
 * The dock bounce and in-app toast provide reliable attention mechanisms
 * regardless of whether the native notification renders.
 */
function showNativeNotification(
  title: string,
  body: string,
  sessionId: string
): void {
  if (!Notification.isSupported()) {
    console.warn('[idle-notifier] Notification.isSupported() returned false — native notification skipped')
    return
  }

  const notification = new Notification({ title, body, silent: true })

  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('navigate-to-session', sessionId)
    }
  })

  notification.on('failed', (_event, error) => {
    console.error('[idle-notifier] Electron notification failed:', error)
  })

  notification.show()
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
  let requiresUserInput = false

  // Detect requiresUserInput from the agent's response regardless of prompt availability
  if (lastResponse) {
    requiresUserInput = detectRequiresUserInput(lastResponse)
  }

  // If the narrow lastResponse didn't detect a question, scan the terminal
  // buffer directly — skipping Claude TUI elements (task list, status bar)
  // that can push the actual question out of the text window.
  if (!requiresUserInput) {
    requiresUserInput = detectQuestionInTerminalBuffer(sessionId)
  }

  // Build an instant summary from the prompt text — never block on a network
  // call.  Short prompts are shown verbatim; long ones get truncated locally.
  // The remote LLM summarizer runs fire-and-forget to upgrade the toast title.
  let summary = defaultLabel
  let cleanedPrompt: string | null = null
  if (lastUserPrompt) {
    cleanedPrompt = normalizePromptText(cleanForSummarization(lastUserPrompt) || lastUserPrompt)
    if (cleanedPrompt.length <= PROMPT_SHORT_THRESHOLD) {
      summary = cleanedPrompt || defaultLabel
    } else {
      summary = truncateText(cleanedPrompt, 60) || defaultLabel
    }
  }

  const heading = getNotificationHeading(agentType, requiresUserInput)
  const shouldShowToast = requiresUserInput || !isLookingAtSession

  // Dispatch notification immediately — no waiting for remote summarization.
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

  // Fire-and-forget: upgrade the toast title with a nicer LLM summary.
  // The notification, sound, and dock bounce have already fired above.
  if (cleanedPrompt && cleanedPrompt.length > PROMPT_SHORT_THRESHOLD) {
    summarizePrompt(cleanedPrompt || lastUserPrompt!).then((betterSummary) => {
      if (notifyGeneration.get(sessionId) !== gen) return // stale
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('idle-notification-summary-update', {
        sessionId,
        title: betterSummary,
      })
    }).catch(() => { /* truncated summary already delivered */ })
  }
}
