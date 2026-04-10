// Minimal "is any terminal running claude" detector for the first-run banner.
//
// This is NOT a state machine — just a boolean signal used to gate the nag
// banner so users who never run claude inside Orchestra don't see it.
//
// The pure `computeHasAnyClaudeRunning` is testable. The `startClaudeRunningDetector`
// factory wires it to a poll loop + IPC emit on transitions.

import { execFileSync } from 'node:child_process'
import type { BrowserWindow } from 'electron'

interface TerminalSessionPidView {
  id: string
  pid: number
}

export function computeHasAnyClaudeRunning(
  sessions: readonly TerminalSessionPidView[],
  getChildProcessNames: (pid: number) => readonly string[],
): boolean {
  for (const s of sessions) {
    const names = getChildProcessNames(s.pid)
    if (names.some((n) => n === 'claude')) return true
  }
  return false
}

export function getChildProcessNamesForPid(pid: number): readonly string[] {
  // Use pgrep -P to find direct children, then ps to get their names.
  // On failure, return empty (caller defaults to false).
  try {
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
    const names: string[] = []
    for (const childPid of children) {
      try {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', childPid], { encoding: 'utf8' }).trim()
        if (comm) names.push(comm.split('/').pop() || comm)
      } catch {
        // ignore — process may have exited between pgrep and ps
      }
    }
    return names
  } catch {
    return []
  }
}

export interface ClaudeRunningDetector {
  stop(): void
  getCurrent(): boolean
}

export function startClaudeRunningDetector(
  mainWindow: BrowserWindow,
  listSessions: () => readonly TerminalSessionPidView[] | Promise<readonly TerminalSessionPidView[]>,
  intervalMs: number = 2000,
): ClaudeRunningDetector {
  let current = false

  const tick = async () => {
    const sessions = await listSessions()
    const next = computeHasAnyClaudeRunning(sessions, getChildProcessNamesForPid)
    if (next !== current) {
      current = next
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claude-running-changed', current)
      }
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)

  return {
    stop() { clearInterval(timer) },
    getCurrent() { return current },
  }
}
