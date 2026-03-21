// terminal-output-buffer.ts
// Captures terminal output per session, strips ANSI codes, and extracts the last
// meaningful text line. Used as a reliable fallback when JSONL/log-based response
// extraction fails to produce results.

import { BrowserWindow } from 'electron'

const BUFFER_SIZE = 4096 // Keep last 4KB of stripped text per session
const EMIT_INTERVAL_MS = 500 // Debounce IPC emissions

// Cursor-movement CSI sequences that represent visual spacing — replaced with
// a space so that text positioned via cursor commands retains word boundaries.
const CURSOR_MOVE_RE = /\x1b\[\d*[CGHf]|\x1b\[\d+;\d+[Hf]/g

// Strip ANSI escape sequences, OSC sequences, and control characters
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[\x20-\x7e]|\r/g

interface SessionBuffer {
  text: string
  lastEmitted: string
  dirty: boolean
}

const buffers = new Map<string, SessionBuffer>()
let mainWindow: BrowserWindow | null = null
let emitTimer: ReturnType<typeof setInterval> | null = null

function stripAnsi(data: string): string {
  return data
    .replace(CURSOR_MOVE_RE, ' ')  // preserve spacing from cursor positioning
    .replace(ANSI_RE, '')
    .replace(/ {2,}/g, ' ')        // collapse runs of spaces from replacements
}

/**
 * Extract the last meaningful line(s) from the buffer.
 * Skips empty lines, box-drawing, prompts, and very short lines.
 */
function extractLastMeaningfulText(buffer: string): string {
  const lines = buffer.split('\n')
  // Walk backwards through last 100 lines to find meaningful text
  const limit = Math.max(0, lines.length - 100)
  for (let i = lines.length - 1; i >= limit; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.length < 3) continue
    // Skip box-drawing / separator lines
    if (/^[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬\-=+|_\s.…●⏺▶▷◆◇○•∙·]+$/.test(line)) continue
    // Skip bare prompt characters
    if (/^[❯❮$%>→]\s*$/.test(line)) continue
    // Skip ANSI remnants that weren't fully stripped
    if (/^\x1b/.test(line)) continue
    // Skip lines without a real word (2+ consecutive letters) — filters terminal noise like ">0q"
    if (!/[a-zA-Z]{2,}/.test(line)) continue
    return line.slice(0, 200)
  }
  return ''
}

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
    buf = { text: '', lastEmitted: '', dirty: false }
    buffers.set(sessionId, buf)
  }

  const stripped = stripAnsi(data)
  if (!stripped) return

  const combined = buf.text + stripped
  buf.text = combined.length > BUFFER_SIZE ? combined.slice(-BUFFER_SIZE) : combined
  buf.dirty = true
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
    if (!line || line.length < 3) continue
    if (/^[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬\-=+|_\s.…●⏺▶▷◆◇○•∙·]+$/.test(line)) continue
    if (/^[❯❮$%>→]\s*$/.test(line)) continue
    if (/^\x1b/.test(line)) continue
    if (!/[a-zA-Z]{2,}/.test(line)) continue
    meaningful.push(line)
  }

  return meaningful.reverse().join(' ').slice(0, 500)
}

export function getTerminalBufferText(sessionId: string): string {
  return buffers.get(sessionId)?.text ?? ''
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
