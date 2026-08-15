// Persistent trace for the chat mirror (remote-bridge-messages.ts).
//
// The main process's stderr goes to /dev/null when the app is launched from
// Finder, so every `console.error` the mirror ever printed was lost — twice a
// per-session stall was diagnosed only from Convex row timestamps, after an app
// restart had already destroyed the in-memory evidence. This log is the trace
// that survives: one line per notable event, appended to
// ~/.orchestra/message-mirror.log, size-rotated so it can never grow without
// bound.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_DIR } from '../daemon/protocol'

const LOG_PATH = path.join(DAEMON_DIR, 'message-mirror.log')
/** Rotate once the file passes this; the previous generation is kept as .1. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

let sink: ((line: string) => void) | null = null

/** Tests (and any future in-app viewer) can capture lines instead of the file. */
export function setMessageMirrorLogSink(fn: ((line: string) => void) | null): void {
  sink = fn
}

export function getMessageMirrorLogPath(): string {
  return LOG_PATH
}

/** Compact, JSON-safe rendering of an error for the log line. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 600)
  return String(err).slice(0, 600)
}

export function mirrorLog(scope: string, details: Record<string, unknown> = {}): void {
  const line = `${new Date().toISOString()} ${scope} ${JSON.stringify(details)}\n`
  if (sink) {
    sink(line)
    return
  }
  try {
    fs.mkdirSync(DAEMON_DIR, { recursive: true })
    try {
      if (fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`)
    } catch {
      // No file yet — nothing to rotate.
    }
    fs.appendFileSync(LOG_PATH, line)
  } catch {
    // Logging must never take the mirror down.
  }
}
