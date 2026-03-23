import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_DIR } from '../daemon/protocol'
import type { WorkStateDebugSnapshot } from '../shared/types'

const DEBUG_LOG_PATH = path.join(DAEMON_DIR, 'work-state-debug.log')
const DEBUG_TAIL_BYTES = 128 * 1024

export function debugWorkState(scope: string, details: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DAEMON_DIR, { recursive: true })
    const line = `${new Date().toISOString()} ${scope} ${JSON.stringify(details)}\n`
    fs.appendFileSync(DEBUG_LOG_PATH, line)
  } catch {}
}

export function getWorkStateDebugLogPath(): string {
  return DEBUG_LOG_PATH
}

export function getWorkStateDebugSnapshot(lineCount = 80): WorkStateDebugSnapshot {
  const safeLineCount = Math.max(1, Math.min(500, Math.floor(lineCount)))

  try {
    const stat = fs.statSync(DEBUG_LOG_PATH)
    const start = Math.max(0, stat.size - DEBUG_TAIL_BYTES)
    const readSize = stat.size - start
    const fd = fs.openSync(DEBUG_LOG_PATH, 'r')
    const buffer = Buffer.alloc(readSize)

    try {
      fs.readSync(fd, buffer, 0, readSize, start)
    } finally {
      fs.closeSync(fd)
    }

    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    return {
      path: DEBUG_LOG_PATH,
      exists: true,
      sizeBytes: stat.size,
      truncated: start > 0,
      tail: lines.slice(-safeLineCount),
    }
  } catch {
    return {
      path: DEBUG_LOG_PATH,
      exists: false,
      sizeBytes: 0,
      truncated: false,
      tail: [],
    }
  }
}
