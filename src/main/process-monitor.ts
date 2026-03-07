// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { ProcessStatus } from '../shared/types'
import { getPtyPid, getAllSessionIds } from './pty-manager'

const lastStatus = new Map<string, ProcessStatus>()
let interval: ReturnType<typeof setInterval> | null = null

function detectProcess(pid: number): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    // Use ps to find child processes — pgrep -P is unreliable on macOS
    execFile('ps', ['-eo', 'ppid,comm'], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('terminal')
        return
      }
      const pidStr = String(pid)
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        const spaceIdx = trimmed.indexOf(' ')
        if (spaceIdx === -1) continue
        const ppid = trimmed.slice(0, spaceIdx).trim()
        const comm = trimmed.slice(spaceIdx + 1).trim().toLowerCase()
        if (ppid === pidStr) {
          if (comm.includes('claude')) {
            resolve('claude')
            return
          }
          if (comm.includes('codex')) {
            resolve('codex')
            return
          }
        }
      }
      resolve('terminal')
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
