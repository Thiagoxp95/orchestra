// src/main/dictation/ears.ts
//
// The warm Qwen3-ASR process (voice-sidecar/ears.py) every phone dictation is
// heard by. It takes seconds to load, so socket.ts starts it when a phone
// opens a terminal and stops it once no phone has needed it for a while.
// Turns are answered in order, one at a time, so a FIFO of resolvers pairs
// each reply line with its request.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveSidecarPaths } from '../voice/sidecar-paths'

/** A Dock-launched app's PATH has no Homebrew in it. */
function findUv(): string {
  const candidates = [
    process.env.ORCHESTRA_UV,
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
    join(homedir(), '.local', 'bin', 'uv'),
    join(homedir(), '.cargo', 'bin', 'uv'),
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? 'uv'
}

interface Turn {
  resolve: (text: string) => void
  reject: (err: Error) => void
}

let child: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let turns: Turn[] = []

export function stopEars(): void {
  child?.kill()
  child = null
  ready = null
}

/** Load the model, if it isn't up; resolves once it can hear. */
export function startEars(): Promise<void> {
  if (ready) return ready
  const script = join(resolveSidecarPaths().sidecarDir, 'ears.py')
  const proc = spawn(findUv(), ['run', '-q', '--script', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
  })
  child = proc
  ready = new Promise<void>((resolve, reject) => {
    let buf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { ready?: boolean; text?: string }
          if (msg.ready) resolve()
          else turns.shift()?.resolve(msg.text ?? '')
        } catch {
          // Not ours: a library printing to stdout.
        }
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) console.log(`[dictation] ${line}`)
    })
    const fail = (err: Error) => {
      if (child === proc) {
        child = null
        ready = null
      }
      reject(err)
      const pending = turns
      turns = []
      for (const t of pending) t.reject(err)
    }
    proc.on('error', (err) => fail(new Error(`The dictation model would not start: ${err.message}`)))
    proc.on('exit', (code, signal) => fail(new Error(`The dictation model exited (${signal ?? code})`)))
  })
  // A rejection nobody awaits yet (a warm-up) must not crash the main process.
  ready.catch(() => {})
  return ready
}

/** Qwen3-ASR's text for 16 kHz mono PCM16. */
export async function hear(pcm: Buffer): Promise<string> {
  await startEars()
  const proc = child
  if (!proc) throw new Error('The dictation model is not running')
  return new Promise<string>((resolve, reject) => {
    turns.push({ resolve, reject })
    const header = Buffer.alloc(4)
    header.writeUInt32LE(Math.floor(pcm.length / 2))
    proc.stdin.write(Buffer.concat([header, pcm.subarray(0, pcm.length - (pcm.length % 2))]))
  })
}
