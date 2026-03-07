// src/main/pty-manager.ts
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import os from 'node:os'
import type { CreateTerminalOpts } from '../shared/types'

const ptys = new Map<string, pty.IPty>()

function getDefaultShell(): string {
  return process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh')
}

export function createPty(
  sessionId: string,
  opts: CreateTerminalOpts,
  window: BrowserWindow
): number {
  const shell = opts.shell || getDefaultShell()
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd === '~' ? os.homedir() : opts.cwd,
    env: process.env as Record<string, string>
  })

  ptyProcess.onData((data) => {
    window.webContents.send('terminal-data', sessionId, data)
  })

  ptyProcess.onExit(() => {
    ptys.delete(sessionId)
    window.webContents.send('terminal-exit', sessionId)
  })

  ptys.set(sessionId, ptyProcess)
  return ptyProcess.pid
}

export function writePty(sessionId: string, data: string): void {
  ptys.get(sessionId)?.write(data)
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  try {
    ptys.get(sessionId)?.resize(cols, rows)
  } catch {
    // PTY fd may already be closed if the process exited
  }
}

export function killPty(sessionId: string): void {
  const p = ptys.get(sessionId)
  if (p) {
    p.kill()
    ptys.delete(sessionId)
  }
}

export function getPtyPid(sessionId: string): number | undefined {
  return ptys.get(sessionId)?.pid
}

export function getAllSessionIds(): string[] {
  return Array.from(ptys.keys())
}

export function killAll(): void {
  for (const [id] of ptys) {
    killPty(id)
  }
}
