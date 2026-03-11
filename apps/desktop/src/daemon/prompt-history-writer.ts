// src/daemon/prompt-history-writer.ts
// Append-only NDJSON writer for user-submitted prompts.
// Separate from history-writer.ts (which stores raw PTY output for restore).

import * as fs from 'node:fs'
import { mkdirSync } from 'node:fs'
import { PROMPT_HISTORY_DIR } from './protocol'

export interface PromptRecord {
  sessionId: string
  submittedAt: string
  text: string
}

type EscapeSequenceState = 'none' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'string' | 'stringEsc'

export function sanitizePromptText(text: string): string {
  let cleaned = text

  // Legacy prompt history may contain terminal query replies without the
  // leading ESC byte because we previously dropped the control character but
  // kept the printable tail. Strip those prefixes on read/write.
  while (true) {
    const next = cleaned
      .replace(/^(?:\[[0-9;?]*[ -/]*[@-~])+/, '')
      .replace(/^(?:\](?:10|11);rgb:[0-9a-f/]+\\)+/i, '')

    if (next === cleaned) break
    cleaned = next
  }

  return cleaned.trim()
}

export class PromptHistoryWriter {
  private fd: number | null = null
  private sessionDir: string
  private promptsPath: string

  // In-memory compose buffer: accumulates user keystrokes until Enter
  private composeBuffer = ''
  private escapeState: EscapeSequenceState = 'none'

  constructor(private sessionId: string) {
    this.sessionDir = `${PROMPT_HISTORY_DIR}/${sessionId}`
    this.promptsPath = `${this.sessionDir}/prompts.ndjson`
  }

  open(): void {
    mkdirSync(this.sessionDir, { recursive: true })
    this.fd = fs.openSync(this.promptsPath, 'a')
  }

  /**
   * Feed user-typed data into the compose buffer.
   * Handles printable text, backspace, paste, and Enter (submit).
   * Only source='user' data should be fed here.
   * Returns the submitted prompt text if Enter was pressed, or null.
   */
  feedUserInput(data: string): string | null {
    let submittedText: string | null = null

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      const code = ch.charCodeAt(0)

      if (this.escapeState !== 'none') {
        this.consumeEscapeSequence(ch, code)
        continue
      }

      if (ch === '\r' || ch === '\n') {
        // Submit: persist if non-empty
        const text = this.submit()
        if (text) submittedText = text
        // Skip \n following \r (CRLF normalization)
        if (ch === '\r' && i + 1 < data.length && data[i + 1] === '\n') {
          i++
        }
      } else if (code === 0x7f || code === 0x08) {
        // Backspace / DEL: remove last character
        if (this.composeBuffer.length > 0) {
          this.composeBuffer = this.composeBuffer.slice(0, -1)
        }
      } else if (code === 0x1b) {
        this.escapeState = 'esc'
      } else if (code < 0x20) {
        // Control characters (Ctrl+C, Ctrl+D, etc.): ignore for prompt composition
        // Also clears the compose buffer since the user is cancelling
        if (code === 0x03 || code === 0x04) {
          // Ctrl+C / Ctrl+D: discard current input
          this.composeBuffer = ''
          this.escapeState = 'none'
        }
        // Other control chars are ignored (tab, etc. could be expanded later)
      } else {
        // Printable character (or part of multi-byte UTF-8)
        this.composeBuffer += ch
      }
    }

    return submittedText
  }

  private submit(): string | null {
    const text = sanitizePromptText(this.composeBuffer)
    this.composeBuffer = ''
    this.escapeState = 'none'

    if (!text) return null
    if (this.fd === null) return null

    const record: PromptRecord = {
      sessionId: this.sessionId,
      submittedAt: new Date().toISOString(),
      text
    }

    try {
      fs.writeSync(this.fd, JSON.stringify(record) + '\n')
    } catch {
      // Best effort — don't crash the session
    }

    return text
  }

  private consumeEscapeSequence(ch: string, code: number): void {
    switch (this.escapeState) {
      case 'esc':
        if (ch === '[') {
          this.escapeState = 'csi'
          return
        }
        if (ch === ']') {
          this.escapeState = 'osc'
          return
        }
        if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
          this.escapeState = 'string'
          return
        }
        this.escapeState = 'none'
        return

      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          this.escapeState = 'none'
        }
        return

      case 'osc':
        if (code === 0x07) {
          this.escapeState = 'none'
          return
        }
        if (code === 0x1b) {
          this.escapeState = 'oscEsc'
        }
        return

      case 'oscEsc':
        this.escapeState = ch === '\\' ? 'none' : 'osc'
        return

      case 'string':
        if (code === 0x1b) {
          this.escapeState = 'stringEsc'
        }
        return

      case 'stringEsc':
        this.escapeState = ch === '\\' ? 'none' : 'string'
        return

      case 'none':
        return
    }
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd) } catch {}
      this.fd = null
    }
  }

  /** Read all prompt records for a session (for the read API) */
  static readHistory(sessionId: string): PromptRecord[] {
    const promptsPath = `${PROMPT_HISTORY_DIR}/${sessionId}/prompts.ndjson`
    try {
      if (!fs.existsSync(promptsPath)) return []
      const content = fs.readFileSync(promptsPath, 'utf8')
      const records: PromptRecord[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line))
        } catch {}
      }
      return records
    } catch {
      return []
    }
  }
}
