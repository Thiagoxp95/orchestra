// src/main/process-monitor.ts
import { execFile } from 'node:child_process'
import { BrowserWindow } from 'electron'
import type { LiveTerminalSessionStatusInfo, ProcessStatus } from '../shared/types'
import type { DaemonClient } from './daemon-client'
import { debugWorkState } from './work-state-debug'

interface DetectResult {
  status: ProcessStatus
  /** PID of the detected Claude/Codex process (if any) */
  aiPid?: number
}

const lastStatus = new Map<string, ProcessStatus>()
const lastAiPid = new Map<string, number>()
let interval: ReturnType<typeof setInterval> | null = null
let daemonClient: DaemonClient | null = null
const MAX_AGENT_DETECTION_DEPTH = 3

function isClaudeCommand(args: string): boolean {
  return args.includes('claude')
}

function isOrchestraClaudeWrapper(args: string): boolean {
  return args.includes('.orchestra') && args.includes('/bin/claude')
}

function isCodexCommand(args: string): boolean {
  return args.includes('codex') && !args.includes('codex app-server')
}

/**
 * Returns true when the process looks like a nested Electron/app instance.
 * Children of such processes belong to that app (e.g. its own PTY sessions),
 * so we must NOT traverse into them — otherwise we'd detect AI tools running
 * inside the nested app as belonging to the parent terminal session.
 */
function isNestedAppProcess(args: string): boolean {
  return (
    args.includes('.app/contents/macos/') ||
    args.includes('/electron ') ||
    args.includes('/electron.') ||
    (args.includes('electron') && args.includes('--type='))
  )
}

function detectProcess(pid: number): Promise<DetectResult> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,args'], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ status: 'terminal' })
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

      const queue: Array<{ pid: string; depth: number }> = [{ pid: String(pid), depth: 0 }]
      while (queue.length > 0) {
        const current = queue.shift()!
        const currentArgs = argsMap.get(current.pid) || ''
        if (isClaudeCommand(currentArgs) && !isOrchestraClaudeWrapper(currentArgs)) {
          resolve({ status: 'claude', aiPid: parseInt(current.pid, 10) })
          return
        }
        if (isCodexCommand(currentArgs)) {
          resolve({ status: 'codex', aiPid: parseInt(current.pid, 10) })
          return
        }

        if (current.depth >= MAX_AGENT_DETECTION_DEPTH) {
          continue
        }

        // Don't traverse into nested Electron apps — their children
        // (PTY sessions, AI tools) belong to the nested app, not ours.
        if (current.depth > 0 && isNestedAppProcess(currentArgs)) {
          continue
        }

        const kids = children.get(current.pid) || []
        for (const kid of kids) {
          const args = argsMap.get(kid) || ''
          if (isClaudeCommand(args) && !isOrchestraClaudeWrapper(args)) {
            resolve({ status: 'claude', aiPid: parseInt(kid, 10) })
            return
          }
          if (isCodexCommand(args)) {
            resolve({ status: 'codex', aiPid: parseInt(kid, 10) })
            return
          }
          queue.push({ pid: kid, depth: current.depth + 1 })
        }
      }
      resolve({ status: 'terminal' })
    })
  })
}

async function detectSessionStatus(session: {
  sessionId: string
  pid: number | null
  cwd: string
  isAlive: boolean
}): Promise<LiveTerminalSessionStatusInfo> {
  if (!session.isAlive || !session.pid) {
    return { ...session, status: 'terminal', aiPid: null }
  }

  const { status, aiPid } = await detectProcess(session.pid)
  return { ...session, status, aiPid: aiPid ?? null }
}

export async function listLiveSessionStatuses(client: DaemonClient): Promise<LiveTerminalSessionStatusInfo[]> {
  const sessions = await client.listSessions()
  return Promise.all(sessions.map((session) => detectSessionStatus(session)))
}

export function startMonitoring(window: BrowserWindow, client: DaemonClient): void {
  if (interval) return
  daemonClient = client

  interval = setInterval(async () => {
    if (window.isDestroyed() || !daemonClient?.isConnected()) return

    try {
      const sessions = await listLiveSessionStatuses(daemonClient)
      for (const session of sessions) {
        if (!session.isAlive || !session.pid) continue

        const { status, aiPid } = session
        const prev = lastStatus.get(session.sessionId)
        const prevPid = lastAiPid.get(session.sessionId)
        if (status !== prev || (aiPid && aiPid !== prevPid)) {
          lastStatus.set(session.sessionId, status)
          if (aiPid) lastAiPid.set(session.sessionId, aiPid)
          else lastAiPid.delete(session.sessionId)
          debugWorkState('process-change', {
            sessionId: session.sessionId,
            cwd: session.cwd,
            pid: session.pid,
            status,
            aiPid,
          })
          window.webContents.send('process-change', session.sessionId, status, aiPid ?? undefined)
        }
      }
    } catch {}
  }, 1000)
}

export function getSessionStatus(sessionId: string): ProcessStatus {
  return lastStatus.get(sessionId) || 'terminal'
}

export function stopMonitoring(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
  lastStatus.clear()
  lastAiPid.clear()
  daemonClient = null
}
