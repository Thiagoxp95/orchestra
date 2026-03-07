// src/daemon/history-writer.ts
// Append-only terminal history writer inspired by Superkey/Superset.
// Writes raw PTY output to disk in real-time so data survives hard kills / reboots.

import * as fs from 'node:fs'
import { mkdirSync } from 'node:fs'
import { HISTORY_DIR } from './protocol'

const MAX_HISTORY_BYTES = 5 * 1024 * 1024 // 5MB per session
const MAX_RESTORE_BYTES = 512 * 1024       // 512KB for cold restore

export class HistoryWriter {
  private fd: number | null = null
  private bytesWritten = 0
  private sessionDir: string
  private scrollbackPath: string
  private metaPath: string

  constructor(
    sessionId: string,
    private cwd: string,
    private cols: number,
    private rows: number
  ) {
    this.sessionDir = `${HISTORY_DIR}/${sessionId}`
    this.scrollbackPath = `${this.sessionDir}/scrollback.bin`
    this.metaPath = `${this.sessionDir}/meta.json`
  }

  open(): void {
    mkdirSync(this.sessionDir, { recursive: true })

    // Open file for appending (creates if doesn't exist)
    this.fd = fs.openSync(this.scrollbackPath, 'a')

    // Get current file size (in case we're resuming)
    try {
      const stat = fs.fstatSync(this.fd)
      this.bytesWritten = stat.size
    } catch {
      this.bytesWritten = 0
    }

    // Write metadata
    this.writeMeta()
  }

  write(data: string): void {
    if (this.fd === null) return

    const buf = Buffer.from(data, 'utf8')
    this.bytesWritten += buf.length

    // Truncate if exceeding max size: rewrite last portion of file
    if (this.bytesWritten > MAX_HISTORY_BYTES) {
      this.truncate()
    }

    try {
      fs.writeSync(this.fd, buf)
    } catch {
      // Best effort — don't crash the session if disk write fails
    }
  }

  updateDimensions(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.writeMeta()
  }

  updateCwd(cwd: string): void {
    this.cwd = cwd
    this.writeMeta()
  }

  close(exitCode?: number): void {
    if (this.fd !== null) {
      // Write final meta with endedAt
      this.writeMeta(exitCode)
      try { fs.closeSync(this.fd) } catch {}
      this.fd = null
    }
  }

  /** Remove all history files for this session (clean exit) */
  cleanup(): void {
    this.close()
    try { fs.unlinkSync(this.scrollbackPath) } catch {}
    try { fs.unlinkSync(this.metaPath) } catch {}
    try { fs.rmdirSync(this.sessionDir) } catch {}
  }

  private writeMeta(exitCode?: number): void {
    const meta: Record<string, any> = {
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      startedAt: new Date().toISOString()
    }
    if (exitCode !== undefined) {
      meta.endedAt = new Date().toISOString()
      meta.exitCode = exitCode
    }
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(meta))
    } catch {}
  }

  private truncate(): void {
    if (this.fd === null) return
    try {
      // Read the last portion of the file
      const keepBytes = MAX_HISTORY_BYTES / 2
      const buf = Buffer.alloc(keepBytes)
      const stat = fs.fstatSync(this.fd)
      const readStart = Math.max(0, stat.size - keepBytes)
      fs.readSync(this.fd, buf, 0, keepBytes, readStart)
      fs.closeSync(this.fd)

      // Rewrite file with just the kept portion
      fs.writeFileSync(this.scrollbackPath, buf)
      this.fd = fs.openSync(this.scrollbackPath, 'a')
      this.bytesWritten = keepBytes
    } catch {
      // If truncation fails, just keep going
    }
  }

  // Static methods for cold restore

  static readForRestore(sessionId: string): { data: string; meta: any } | null {
    const sessionDir = `${HISTORY_DIR}/${sessionId}`
    const scrollbackPath = `${sessionDir}/scrollback.bin`
    const metaPath = `${sessionDir}/meta.json`

    try {
      // Check meta first
      if (!fs.existsSync(metaPath)) return null
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))

      // If session ended cleanly, skip restore
      if (meta.endedAt) return null

      // Read scrollback
      if (!fs.existsSync(scrollbackPath)) return null
      const stat = fs.statSync(scrollbackPath)
      if (stat.size === 0) return null

      let data: string
      if (stat.size > MAX_RESTORE_BYTES) {
        // Read only the tail
        const fd = fs.openSync(scrollbackPath, 'r')
        const buf = Buffer.alloc(MAX_RESTORE_BYTES)
        fs.readSync(fd, buf, 0, MAX_RESTORE_BYTES, stat.size - MAX_RESTORE_BYTES)
        fs.closeSync(fd)
        data = buf.toString('utf8')
      } else {
        data = fs.readFileSync(scrollbackPath, 'utf8')
      }

      return { data, meta }
    } catch {
      return null
    }
  }

  static cleanupSession(sessionId: string): void {
    const sessionDir = `${HISTORY_DIR}/${sessionId}`
    try { fs.unlinkSync(`${sessionDir}/scrollback.bin`) } catch {}
    try { fs.unlinkSync(`${sessionDir}/meta.json`) } catch {}
    try { fs.rmdirSync(sessionDir) } catch {}
  }
}
