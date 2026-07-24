// terminal-output-buffer.ts
// Captures terminal output per session, strips ANSI codes, and extracts the last
// meaningful text line. Used as a reliable fallback when JSONL/log-based response
// extraction fails to produce results.

import { BrowserWindow } from 'electron'
import { extractLastMeaningfulText, isTrivialLine, stripAnsi } from './terminal-output-text'

const BUFFER_SIZE = 4096 // Keep last 4KB of stripped text per session
const EMIT_INTERVAL_MS = 500 // Debounce IPC emissions

interface SessionBuffer {
  text: string
  lastEmitted: string
  dirty: boolean
  lastOutputAt: number | null
  /** Buffer length when the agent started working — text after this is the agent's response. */
  workStartOffset: number
}

const buffers = new Map<string, SessionBuffer>()
let mainWindow: BrowserWindow | null = null
let emitTimer: ReturnType<typeof setInterval> | null = null

function emitPendingUpdates(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  for (const [sessionId, buf] of buffers) {
    if (!buf.dirty) continue
    buf.dirty = false

    const text = extractLastMeaningfulText(buf.text)
    if (!text || text === buf.lastEmitted) continue
    buf.lastEmitted = text
    mainWindow.webContents.send('terminal-last-output', sessionId, text)
  }
}

// --- Public API ---

export function initTerminalOutputBuffer(window: BrowserWindow): void {
  mainWindow = window
  if (!emitTimer) {
    emitTimer = setInterval(emitPendingUpdates, EMIT_INTERVAL_MS)
  }
}

export function feedTerminalOutput(sessionId: string, data: string): void {
  let buf = buffers.get(sessionId)
  if (!buf) {
    buf = { text: '', lastEmitted: '', dirty: false, lastOutputAt: null, workStartOffset: 0 }
    buffers.set(sessionId, buf)
  }

  const stripped = stripAnsi(data)
  if (!stripped) return

  const combined = buf.text + stripped
  if (combined.length > BUFFER_SIZE) {
    const trimmed = combined.length - BUFFER_SIZE
    buf.text = combined.slice(-BUFFER_SIZE)
    buf.workStartOffset = Math.max(0, buf.workStartOffset - trimmed)
  } else {
    buf.text = combined
  }
  buf.dirty = true
  if (stripped.trim()) {
    buf.lastOutputAt = Date.now()
  }
}

/**
 * Get the last meaningful text from a session's terminal output buffer.
 * Returns multiple recent meaningful lines (up to `maxLines`) joined together,
 * giving question detection enough context to find a `?` even if it's not
 * on the very last line.
 */
export function getLastMeaningfulText(sessionId: string, maxLines = 10): string {
  const buf = buffers.get(sessionId)
  if (!buf) return ''

  const lines = buf.text.split('\n')
  const limit = Math.max(0, lines.length - 100)
  const meaningful: string[] = []

  for (let i = lines.length - 1; i >= limit && meaningful.length < maxLines; i--) {
    const line = lines[i].trim()
    if (!line || isTrivialLine(line)) continue
    meaningful.push(line)
  }

  return meaningful.reverse().join(' ').slice(0, 500)
}

export function getTerminalBufferText(sessionId: string): string {
  return buffers.get(sessionId)?.text ?? ''
}

/**
 * Snapshot the current buffer length so we know where the agent's response starts.
 * Call this when the agent transitions to 'working'.
 */
export function markWorkingStart(sessionId: string): void {
  const buf = buffers.get(sessionId)
  if (buf) {
    buf.workStartOffset = buf.text.length
  }
}

/**
 * Return only the text added to the buffer since `markWorkingStart` was called.
 * This is the agent's response — excludes anything the user typed before the agent started.
 */
export function getAgentResponseText(sessionId: string): string {
  const buf = buffers.get(sessionId)
  if (!buf) return ''
  return buf.text.slice(buf.workStartOffset)
}

export function hasRecentTerminalOutput(sessionId: string, maxAgeMs: number): boolean {
  const lastOutputAt = buffers.get(sessionId)?.lastOutputAt
  return lastOutputAt != null && (Date.now() - lastOutputAt) < maxAgeMs
}

export function clearSessionBuffer(sessionId: string): void {
  buffers.delete(sessionId)
}

export function stopTerminalOutputBuffer(): void {
  if (emitTimer) {
    clearInterval(emitTimer)
    emitTimer = null
  }
  buffers.clear()
  mainWindow = null
}
