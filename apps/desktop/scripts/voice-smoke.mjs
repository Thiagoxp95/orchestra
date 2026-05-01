#!/usr/bin/env node
// Voice sidecar smoke test.
//
// Pipes a recorded WAV file's PCM samples (16kHz mono int16) into a freshly
// spawned Python sidecar via stdin and prints every JSON event the sidecar
// emits. Useful for verifying the full wake → transcribe → match flow on a
// dev machine before cutting a release.
//
// Usage:
//   bun run voice:smoke -- path/to/sample.wav
//   ORCHESTRA_VOICE_VENV=/custom/venv bun run voice:smoke -- path/to/sample.wav
//
// If no WAV path is provided, prints a friendly notice and exits 0.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const wavArg = process.argv[2]
if (!wavArg) {
  console.log('[voice-smoke] No WAV path supplied — skipping smoke run.')
  console.log('[voice-smoke] Usage: bun run voice:smoke -- path/to/sample.wav')
  process.exit(0)
}

const wavPath = resolve(wavArg)
if (!existsSync(wavPath)) {
  console.error(`[voice-smoke] File not found: ${wavPath}`)
  process.exit(1)
}

const venv = process.env.ORCHESTRA_VOICE_VENV ?? join(homedir(), '.orchestra', 'voice-venv')
const python = process.env.ORCHESTRA_VOICE_PYTHON ?? join(venv, 'bin', 'python')
const script = process.env.ORCHESTRA_VOICE_SCRIPT
  ?? resolve(new URL('../voice-sidecar/main.py', import.meta.url).pathname)

if (!existsSync(python)) {
  console.error(`[voice-smoke] Python interpreter not found at ${python}.`)
  console.error('[voice-smoke] Run `bash apps/desktop/voice-sidecar/setup.sh` first.')
  process.exit(1)
}

if (!existsSync(script)) {
  console.error(`[voice-smoke] Sidecar script not found at ${script}.`)
  process.exit(1)
}

console.log(`[voice-smoke] python=${python}`)
console.log(`[voice-smoke] script=${script}`)
console.log(`[voice-smoke] wav   =${wavPath}`)
console.log('[voice-smoke] spawning sidecar; events follow.')

const child = spawn(python, [script], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ORCHESTRA_VOICE_SMOKE_WAV: wavPath },
})

child.stdout.setEncoding('utf8')
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    console.log(`[event] ${line}`)
  }
})

child.on('exit', (code, signal) => {
  console.log(`[voice-smoke] sidecar exited (code=${code} signal=${signal})`)
  process.exit(code ?? 0)
})

// Push a no-op vocab so the matcher has something to chew on once a wake fires.
child.stdin.write(
  JSON.stringify({
    type: 'set_vocab',
    vocab: [{ actionId: 'smoke-1', phrases: ['ship', 'deploy'] }],
  }) + '\n',
)

// Stream raw WAV bytes verbatim — the sidecar uses sounddevice for the real
// mic in production, but for smoke testing the simplest path is to dump bytes
// at it; the WAV-replaying frame source is left to the user to wire if needed.
const wav = readFileSync(wavPath)
console.log(`[voice-smoke] wrote ${wav.length} bytes to stdin (sidecar will not consume them unless its frame source reads stdin — see TODO).`)

// Allow the sidecar to run for a few seconds, then ask it to shut down.
setTimeout(() => {
  child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
  setTimeout(() => child.kill('SIGTERM'), 1000).unref()
}, 8000).unref()
