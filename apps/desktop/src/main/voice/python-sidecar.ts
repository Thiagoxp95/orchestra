// Production sidecar adapter — spawns the Python child at
// `~/.orchestra/voice-venv/bin/python apps/desktop/voice-sidecar/main.py`
// and adapts node `child_process` IO to the SidecarHandle contract.

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { VoiceEvent } from '../../shared/types'
import type { SidecarHandle, SidecarSpawnOptions } from './voice-manager'

export interface PythonSidecarPaths {
  python: string
  script: string
}

export function defaultPythonSidecarPaths(): PythonSidecarPaths {
  const venv = process.env.ORCHESTRA_VOICE_VENV ?? join(homedir(), '.orchestra', 'voice-venv')
  return {
    python: join(venv, 'bin', 'python'),
    script: resolveScriptPath(),
  }
}

/**
 * The voice-sidecar source is shipped under `voice-sidecar/` inside the app
 * resources directory. In dev we resolve relative to the repo, in prod
 * relative to the app's `process.resourcesPath`.
 */
function resolveScriptPath(): string {
  if (process.env.ORCHESTRA_VOICE_SCRIPT) return process.env.ORCHESTRA_VOICE_SCRIPT
  // electron's resourcesPath only exists at runtime under packaged builds.
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) {
    return join(resources, 'voice-sidecar', 'main.py')
  }
  // Dev fallback: this file lives at apps/desktop/src/main/voice/python-sidecar.ts;
  // the script is at apps/desktop/voice-sidecar/main.py relative to the repo.
  return join(process.cwd(), 'apps', 'desktop', 'voice-sidecar', 'main.py')
}

export function spawnPythonSidecar(opts: SidecarSpawnOptions): SidecarHandle {
  const { python, script } = defaultPythonSidecarPaths()
  const args: string[] = [script]
  if (opts.wakeWord) args.push('--wake-word', opts.wakeWord)
  if (typeof opts.wakeThreshold === 'number') args.push('--wake-threshold', String(opts.wakeThreshold))
  if (typeof opts.intentThreshold === 'number') args.push('--intent-threshold', String(opts.intentThreshold))

  const child = spawn(python, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  }) as ChildProcessByStdio<Writable, Readable, Readable>

  const eventListeners: Array<(event: VoiceEvent) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const stderrListeners: Array<(line: string) => void> = []

  let stdoutBuf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (isVoiceEvent(parsed)) {
          for (const fn of eventListeners) fn(parsed)
        }
      } catch {
        // Drop malformed lines — they shouldn't happen in practice but
        // discarding is safer than crashing the manager.
      }
    }
  })

  let stderrBuf = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx)
      stderrBuf = stderrBuf.slice(idx + 1)
      for (const fn of stderrListeners) fn(line)
    }
  })

  child.on('exit', (code, signal) => {
    for (const fn of exitListeners) fn(code, signal)
  })

  child.on('error', (err) => {
    for (const fn of stderrListeners) fn(`spawn error: ${err.message}`)
  })

  return {
    onEvent(listener) {
      eventListeners.push(listener)
    },
    onExit(listener) {
      exitListeners.push(listener)
    },
    onStderr(listener) {
      stderrListeners.push(listener)
    },
    send(command) {
      try {
        child.stdin.write(JSON.stringify(command) + '\n')
      } catch {
        // The child went away mid-write; the exit handler will fire.
      }
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      try {
        child.kill(signal)
      } catch {}
    },
  }
}

function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (!value || typeof value !== 'object') return false
  const t = (value as { type?: unknown }).type
  return typeof t === 'string'
}
