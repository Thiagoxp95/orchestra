// src/main/daemon-launcher.ts
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH, DAEMON_META_PATH } from '../daemon/protocol'
import { buildNodeChildEnv, resolveNodeExecPath } from './node-runtime'

interface DaemonMeta {
  nodeExecPath?: string
  codeSignature?: string
}

let ensuringDaemon: Promise<void> | null = null
let warnedDeferredUpgrade = false
let spawnedPid: number | undefined

function readDaemonPid(): number | null {
  try {
    const value = fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim()
    const pid = Number(value)
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid)) throw new Error('Invalid daemon PID metadata')
    return pid
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function readDaemonMeta(): DaemonMeta | null {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_META_PATH, 'utf8'))
  } catch {
    return null
  }
}

function getDaemonCodeSignature(): string {
  const files = [
    'daemon.js',
    'session.js',
    'protocol.js',
    'pty-subprocess.js',
    'node-runtime.js',
  ]

  return files.map((file) => {
    const filePath = join(__dirname, file)
    try {
      const content = fs.readFileSync(filePath)
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
      return `${file}:${hash}`
    } catch {
      return `${file}:missing`
    }
  }).join('|')
}

function daemonState(): 'alive' | 'dead' | 'unknown' {
  try {
    const pids = new Set([readDaemonPid(), spawnedPid].filter((pid): pid is number => typeof pid === 'number'))
    for (const pid of pids) {
      try {
        process.kill(pid, 0) // Probe only. Never terminate an existing daemon.
        return 'alive'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'unknown'
      }
    }
    return 'dead'
  } catch {
    return 'unknown'
  }
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(DAEMON_SOCKET_PATH)
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(connected)
    }
    const timer = setTimeout(() => finish(false), 1000)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

function spawnDaemon(nodeExecPath: string, codeSignature: string): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true })

  // Path to compiled daemon.js — lives alongside main process files
  const daemonPath = join(__dirname, 'daemon.js')

  const logPath = join(DAEMON_DIR, 'daemon.log')
  const logFd = fs.openSync(logPath, 'a')

  const child = spawn(nodeExecPath, [daemonPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: buildNodeChildEnv({
      ORCHESTRA_NODE_EXEC_PATH: nodeExecPath,
      ORCHESTRA_DAEMON_CODE_SIGNATURE: codeSignature,
    })
  })
  // Retain the child identity even if startup times out before its PID file is
  // written. A subsequent retry must not launch a competing daemon over it.
  spawnedPid = child.pid

  child.on('error', (err) => {
    console.error('[daemon-launcher] Failed to spawn daemon:', err.message)
  })

  child.unref()
  fs.closeSync(logFd)
}

async function ensureDaemonOnce(): Promise<void> {
  const nodeExecPath = resolveNodeExecPath()
  const codeSignature = getDaemonCodeSignature()

  // A healthy socket is sufficient even if the PID metadata was lost. Replacing
  // a healthy old daemon terminates every PTY it owns, so upgrades must defer.
  if (await canConnect()) {
    const meta = readDaemonMeta()
    if (!warnedDeferredUpgrade && (meta?.nodeExecPath !== nodeExecPath || meta?.codeSignature !== codeSignature)) {
      warnedDeferredUpgrade = true
      console.warn('[daemon-launcher] Daemon upgrade deferred to preserve running terminals. The existing daemon remains in use; bundled daemon fixes take effect after it exits and safely starts again.')
    }
    return
  }

  // A failed socket probe does not prove the process died: startup, a paused
  // event loop, or permissions can all make a live daemon temporarily unreachable.
  if (daemonState() !== 'dead') {
    throw new Error('Terminal daemon is still running or its status cannot be verified, but its socket is unavailable. Active terminals have been preserved; retry the connection shortly.')
  }

  // Clean up stale files
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_META_PATH) } catch {}

  // Spawn fresh daemon
  spawnDaemon(nodeExecPath, codeSignature)

  // Wait for socket to become available
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await canConnect()) return
  }

  throw new Error('Failed to start terminal daemon')
}

export function ensureDaemon(): Promise<void> {
  if (ensuringDaemon) return ensuringDaemon
  const pending = ensureDaemonOnce().finally(() => {
    if (ensuringDaemon === pending) ensuringDaemon = null
  })
  ensuringDaemon = pending
  return pending
}
