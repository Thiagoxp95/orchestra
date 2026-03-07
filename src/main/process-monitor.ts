// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { ProcessStatus } from '../shared/types'
import { getPtyPid, getAllSessionIds } from './pty-manager'

const lastStatus = new Map<string, ProcessStatus>()
let interval: ReturnType<typeof setInterval> | null = null

function detectProcess(pid: number): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-lP', String(pid)], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('terminal')
        return
      }
      const lines = stdout.trim().toLowerCase()
      if (lines.includes('claude')) {
        resolve('claude')
      } else if (lines.includes('codex')) {
        resolve('codex')
      } else {
        resolve('terminal')
      }
    })
  })
}

export function startMonitoring(window: BrowserWindow): void {
  if (interval) return

  interval = setInterval(async () => {
    const sessionIds = getAllSessionIds()
    for (const sessionId of sessionIds) {
      const pid = getPtyPid(sessionId)
      if (!pid) continue

      const status = await detectProcess(pid)
      const prev = lastStatus.get(sessionId)
      if (status !== prev) {
        lastStatus.set(sessionId, status)
        window.webContents.send('process-change', sessionId, status)
      }
    }
  }, 2000)
}

export function stopMonitoring(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  lastStatus.clear()
}
