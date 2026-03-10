// src/main/daemon-launcher.ts
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH, DAEMON_META_PATH } from '../daemon/protocol'
import { buildNodeChildEnv, resolveNodeExecPath } from './node-runtime'

interface DaemonMeta {
  nodeExecPath?: string
}

function readDaemonPid(): number | null {
  try {
    return parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim(), 10)
  } catch {
    return null
  }
}

function readDaemonMeta(): DaemonMeta | null {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_META_PATH, 'utf8'))
  } catch {
    return null
  }
}

function isDaemonRunning(): boolean {
  try {
    const pid = readDaemonPid()
    if (!pid) return false
    process.kill(pid, 0) // Check if process exists (signal 0)
    return true
  } catch {
    return false
  }
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(DAEMON_SOCKET_PATH)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      resolve(false)
    })
    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 1000)
  })
}

async function stopDaemon(): Promise<void> {
  const pid = readDaemonPid()
  if (!pid) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch {}

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!isDaemonRunning()) return
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

function spawnDaemon(nodeExecPath: string): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true })

  // Path to compiled daemon.js — lives alongside main process files
  const daemonPath = join(__dirname, 'daemon.js')

  const logPath = join(DAEMON_DIR, 'daemon.log')
  const logFd = fs.openSync(logPath, 'a')

  const child = spawn(nodeExecPath, [daemonPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: buildNodeChildEnv({ ORCHESTRA_NODE_EXEC_PATH: nodeExecPath })
  })

  child.on('error', (err) => {
    console.error('[daemon-launcher] Failed to spawn daemon:', err.message)
  })

  child.unref()
  fs.closeSync(logFd)
}

export async function ensureDaemon(): Promise<void> {
  const nodeExecPath = resolveNodeExecPath()

  // Fast path: daemon already running and connectable
  if (isDaemonRunning() && await canConnect()) {
    const meta = readDaemonMeta()
    if (meta?.nodeExecPath === nodeExecPath) return
    await stopDaemon()
  }

  // Clean up stale files
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_META_PATH) } catch {}

  // Spawn fresh daemon
  spawnDaemon(nodeExecPath)

  // Wait for socket to become available
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await canConnect()) return
  }

  throw new Error('Failed to start terminal daemon')
}
