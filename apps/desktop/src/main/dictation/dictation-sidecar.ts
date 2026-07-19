// Spawns the Python dictation sidecar at
// `~/.orchestra/voice-venv/bin/python apps/desktop/voice-sidecar/dictation.py`
// and adapts child_process IO to the DictationSidecarHandle contract. Mirrors
// voice/python-sidecar.ts; reuses the same venv + sidecar dir (already shipped
// via electron-builder extraResources).

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { resolveSidecarPaths } from '../voice/sidecar-paths'

export type DictationEvent =
  | { type: 'ready' }
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string }

export interface DictationSidecarHandle {
  onEvent(cb: (event: DictationEvent) => void): void
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
  onStderr(cb: (line: string) => void): void
  sendAudio(pcmBase64: string): void
  end(): void
  reset(): void
  shutdown(): void
  kill(signal?: NodeJS.Signals): void
}

export type DictationSidecarFactory = () => DictationSidecarHandle

export function spawnDictationSidecar(): DictationSidecarHandle {
  const paths = resolveSidecarPaths()
  const script = join(paths.sidecarDir, 'dictation.py')

  const child = spawn(paths.venvPython, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  }) as ChildProcessByStdio<Writable, Readable, Readable>

  const eventListeners: Array<(e: DictationEvent) => void> = []
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
        if (parsed && typeof parsed.type === 'string') {
          for (const fn of eventListeners) fn(parsed as DictationEvent)
        }
      } catch {
        // Drop malformed lines rather than crash the orchestrator.
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

  const send = (command: object) => {
    try {
      child.stdin.write(JSON.stringify(command) + '\n')
    } catch {
      // child went away mid-write; the exit handler will fire
    }
  }

  return {
    onEvent(cb) { eventListeners.push(cb) },
    onExit(cb) { exitListeners.push(cb) },
    onStderr(cb) { stderrListeners.push(cb) },
    sendAudio(pcmBase64) { send({ type: 'audio', pcm: pcmBase64 }) },
    end() { send({ type: 'end' }) },
    reset() { send({ type: 'reset' }) },
    shutdown() { send({ type: 'shutdown' }) },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      try { child.kill(signal) } catch {}
    },
  }
}
