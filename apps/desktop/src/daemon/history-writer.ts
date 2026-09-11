// src/daemon/history-writer.ts
// Append-only terminal history writer inspired by Superkey/Superset.
// Writes raw PTY output to disk in real-time so data survives hard kills / reboots.

import * as fs from 'node:fs'
import { mkdirSync } from 'node:fs'
import { HISTORY_DIR } from './protocol'

const MAX_HISTORY_BYTES = 5 * 1024 * 1024 // 5MB per session
const WRITE_RETRY_MS = 1000
let nextReplacementId = 0
const MAX_RESTORE_BYTES = 512 * 1024       // 512KB for cold restore

export class HistoryWriter {
  private fd: number | null = null
  private bytesWritten = 0
  private retryAfter = 0
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
    if (this.fd !== null) return
    mkdirSync(this.sessionDir, { recursive: true })
    // Trimming needs to read the tail from the same live descriptor.
    const fd = fs.openSync(this.scrollbackPath, 'a+')
    try {
      this.bytesWritten = fs.fstatSync(fd).size
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
    this.fd = fd
    this.retryAfter = 0
    this.writeMeta()
  }

  write(data: string): void {
    if (this.fd === null || Date.now() < this.retryAfter || data.length === 0) return

    // A single PTY chunk can itself exceed the cap. Only its newest bytes fit.
    const buf = Buffer.from(data, 'utf8').subarray(-MAX_HISTORY_BYTES)
    try {
      if (this.bytesWritten + buf.length > MAX_HISTORY_BYTES) {
        this.truncate(buf)
      } else {
        this.writeAll(this.fd, buf)
        this.bytesWritten += buf.length
      }
    } catch {
      // History is best effort. Avoid retrying a large trim on every PTY event
      // when the disk is full, and reconcile any partially completed append.
      this.retryAfter = Date.now() + WRITE_RETRY_MS
      try {
        this.bytesWritten = fs.fstatSync(this.fd).size
      } catch {
        try { fs.closeSync(this.fd) } catch {}
        this.fd = null
      }
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

  private writeAll(fd: number, data: Buffer): void {
    let offset = 0
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, null)
      if (written <= 0) throw new Error('Terminal history write made no progress')
      offset += written
    }
  }

  private truncate(incoming: Buffer): void {
    if (this.fd === null) return
    const oldFd = this.fd
    const size = fs.fstatSync(oldFd).size
    const keepBytes = Math.min(size, MAX_HISTORY_BYTES / 2, MAX_HISTORY_BYTES - incoming.length)
    const tail = Buffer.alloc(keepBytes)
    let offset = 0
    while (offset < keepBytes) {
      const read = fs.readSync(oldFd, tail, offset, keepBytes - offset, size - keepBytes + offset)
      if (read <= 0) throw new Error('Terminal history tail ended unexpectedly')
      offset += read
    }

    // Keep the original file and descriptor intact until the complete bounded
    // replacement is ready. Failed reads/writes/renames cannot strand a closed fd.
    const replacementPath = `${this.scrollbackPath}.trim-${process.pid}-${nextReplacementId++}`
    let replacementFd: number | null = null
    try {
      replacementFd = fs.openSync(replacementPath, 'ax+', 0o600)
      this.writeAll(replacementFd, tail)
      this.writeAll(replacementFd, incoming)
      fs.renameSync(replacementPath, this.scrollbackPath)
      this.fd = replacementFd
      replacementFd = null
      this.bytesWritten = keepBytes + incoming.length
      try { fs.closeSync(oldFd) } catch {}
    } finally {
      if (replacementFd !== null) {
        try { fs.closeSync(replacementFd) } catch {}
        try { fs.unlinkSync(replacementPath) } catch {}
      }
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
