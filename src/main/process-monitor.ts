// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { ProcessStatus } from '../shared/types'
import type { DaemonClient } from './daemon-client'

const lastStatus = new Map<string, ProcessStatus>()
let interval: ReturnType<typeof setInterval> | null = null
let daemonClient: DaemonClient | null = null

function detectProcess(pid: number): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,args'], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('terminal')
        return
      }
      const children = new Map<string, string[]>()
      const argsMap = new Map<string, string>()
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        const parts = trimmed.split(/\s+/)
        if (parts.length < 3) continue
        const cpid = parts[0]
        const ppid = parts[1]
        const args = parts.slice(2).join(' ').toLowerCase()
        argsMap.set(cpid, args)
        if (!children.has(ppid)) children.set(ppid, [])
        children.get(ppid)!.push(cpid)
      }

      const queue = [String(pid)]
      while (queue.length > 0) {
        const current = queue.shift()!
        const kids = children.get(current) || []
        for (const kid of kids) {
          const args = argsMap.get(kid) || ''
          if (args.includes('claude')) {
            resolve('claude')
            return
          }
          if (args.includes('codex')) {
            resolve('codex')
            return
          }
          queue.push(kid)
        }
      }
      resolve('terminal')
    })
  })
}

export function startMonitoring(window: BrowserWindow, client: DaemonClient): void {
  if (interval) return
  daemonClient = client

  interval = setInterval(async () => {
    if (window.isDestroyed() || !daemonClient?.isConnected()) return

    try {
      const sessions = await daemonClient.listSessions()
      for (const session of sessions) {
        if (!session.isAlive || !session.pid) continue

        const status = await detectProcess(session.pid)
        const prev = lastStatus.get(session.sessionId)
        if (status !== prev) {
          lastStatus.set(session.sessionId, status)
          window.webContents.send('process-change', session.sessionId, status)
        }
      }
    } catch {}
  }, 2000)
}

export function stopMonitoring(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  lastStatus.clear()
  daemonClient = null
}
