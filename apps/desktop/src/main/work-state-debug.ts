import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_DIR } from '../daemon/protocol'

const DEBUG_LOG_PATH = path.join(DAEMON_DIR, 'work-state-debug.log')

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
