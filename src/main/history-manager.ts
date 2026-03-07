// src/main/history-manager.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HISTORY_DIR } from '../daemon/protocol'

const MAX_HISTORY_BYTES = 5 * 1024 * 1024 // 5MB per session

interface HistoryMeta {
  cwd: string
  cols: number
  rows: number
  startedAt: string
  endedAt?: string
}

// Active writers
const writers = new Map<string, { fd: number; bytesWritten: number; dir: string }>()

function sessionDir(workspaceId: string, sessionId: string): string {
  return path.join(HISTORY_DIR, workspaceId, sessionId)
}

export function startHistoryWriter(workspaceId: string, sessionId: string, meta: Omit<HistoryMeta, 'startedAt'>): void {
  const dir = sessionDir(workspaceId, sessionId)
  fs.mkdirSync(dir, { recursive: true })

  // Write meta
  const metaData: HistoryMeta = { ...meta, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaData))

  // Open scrollback file for appending
  const fd = fs.openSync(path.join(dir, 'scrollback.bin'), 'w')
  writers.set(sessionId, { fd, bytesWritten: 0, dir })
}

export function appendHistoryData(sessionId: string, data: string): void {
  const writer = writers.get(sessionId)
  if (!writer) return
  if (writer.bytesWritten >= MAX_HISTORY_BYTES) return

  const buf = Buffer.from(data, 'utf8')
  const toWrite = Math.min(buf.length, MAX_HISTORY_BYTES - writer.bytesWritten)
  fs.writeSync(writer.fd, buf, 0, toWrite)
  writer.bytesWritten += toWrite
}

export function endHistoryWriter(sessionId: string): void {
  const writer = writers.get(sessionId)
  if (!writer) return

  fs.closeSync(writer.fd)

  // Update meta with endedAt
  try {
    const metaPath = path.join(writer.dir, 'meta.json')
    const meta: HistoryMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.endedAt = new Date().toISOString()
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {}

  writers.delete(sessionId)
}

export function loadColdRestore(workspaceId: string, sessionId: string): { scrollback: string; meta: HistoryMeta } | null {
  const dir = sessionDir(workspaceId, sessionId)

  try {
    const meta: HistoryMeta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    // Only restore if no endedAt (unclean shutdown)
    if (meta.endedAt) return null

    const scrollback = fs.readFileSync(path.join(dir, 'scrollback.bin'), 'utf8')
    return { scrollback, meta }
  } catch {
    return null
  }
}

export function cleanupHistory(workspaceId: string, sessionId: string): void {
  const dir = sessionDir(workspaceId, sessionId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}
