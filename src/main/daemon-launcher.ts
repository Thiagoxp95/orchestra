// src/main/daemon-launcher.ts
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { DAEMON_DIR, DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from '../daemon/protocol'

function isDaemonRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim(), 10)
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

function spawnDaemon(): void {
  fs.mkdirSync(DAEMON_DIR, { recursive: true })

  // Path to compiled daemon.js — lives alongside main process files
  const daemonPath = join(__dirname, 'daemon.js')

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })

  child.unref()
}

export async function ensureDaemon(): Promise<void> {
  // Fast path: daemon already running and connectable
  if (isDaemonRunning() && await canConnect()) return

  // Clean up stale files
  try { fs.unlinkSync(DAEMON_SOCKET_PATH) } catch {}
  try { fs.unlinkSync(DAEMON_PID_PATH) } catch {}

  // Spawn fresh daemon
  spawnDaemon()

  // Wait for socket to become available
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await canConnect()) return
  }

  throw new Error('Failed to start terminal daemon')
}
